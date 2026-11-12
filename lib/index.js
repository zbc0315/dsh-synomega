// src/index.ts
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { dirname as dirname3, join as join3 } from "node:path";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";

// src/config.ts
import Schema from "@deepseek-ai/schemastery";
var Config = Schema.object({
  autoSetup: Schema.boolean().default(true).description("Provision the Python environment and prefetch assets on activation."),
  python: Schema.string().description("Explicit interpreter path (>=3.10). Set it and no virtualenv is created."),
  venvDir: Schema.string().description("Virtualenv location. Defaults to <DSH_HOME>/plugins/synomega/venv."),
  extras: Schema.array(Schema.string()).default(["gnn"]).description("PyPI extras. [] installs the template-only backend (no torch, much faster)."),
  downloadAssets: Schema.boolean().default(true).description("Run `synomega download` during setup to prefetch models and stock."),
  mirror: Schema.union(["auto", "ustc", "github"]).default("auto").description("Asset mirror; maps to SYNOMEGA_MIRROR."),
  cacheDir: Schema.string().description("Asset cache directory; maps to SYNOMEGA_CACHE."),
  plausibility: Schema.boolean().default(false).description("Screen single-step candidates with the plausibility model. Off by default: it does not improve top-k recall and adds latency."),
  plausibilityThreshold: Schema.number().default(0.4),
  algorithm: Schema.union(["retrostar", "mcts", "bfs"]).default("retrostar"),
  simplifyPlanning: Schema.boolean().default(false).description("Back route planning with the simplification-constrained model. Scoring uses it regardless \u2014 that is SynOmega's recommended scoring configuration."),
  search: Schema.object({
    expansionWidth: Schema.number().default(50),
    timeLimitS: Schema.number().default(60),
    maxExpansions: Schema.number().default(500)
  }).default({ expansionWidth: 50, timeLimitS: 60, maxExpansions: 500 }),
  queueLimit: Schema.number().default(8).description("Pending requests allowed before new calls are refused outright."),
  timeouts: Schema.object({
    retro: Schema.number().default(12e4),
    forward: Schema.number().default(12e4),
    plan: Schema.number().default(6e5),
    score: Schema.number().default(6e5),
    evolve: Schema.number().default(6e5)
  }).default({ retro: 12e4, forward: 12e4, plan: 6e5, score: 6e5, evolve: 6e5 }),
  workerIdleTimeoutMs: Schema.number().default(18e5).description("Retire the resident Python worker after this long idle. Zero keeps it forever."),
  hardKillMs: Schema.number().default(6e4).description("After a call is abandoned, how long to wait before killing the worker outright. Python inference cannot be interrupted cooperatively."),
  visualize: Schema.boolean().default(true).description("Emit presentation metadata for the browser cards. Off leaves text-only results."),
  maxTreeNodes: Schema.number().default(120).description("Node cap for a rendered route tree; a larger tree is truncated and labelled as such."),
  maxCardItems: Schema.number().default(12).description("Predictions or molecules projected into one card."),
  ketcher: Schema.object({
    enabled: Schema.boolean().default(true).description("Offer the Ketcher molecule editor from the composer. Needs a web server in the composition."),
    prefetch: Schema.boolean().default(false).description("Fetch the editor at activation. Off by default: it is a 35 MB download nobody who never draws should pay for."),
    version: Schema.string().default("3.17.0").description("Ketcher release to install."),
    url: Schema.string().description("Release archive URL. Defaults to the matching GitHub release; set it to use a mirror or an offline copy.")
  }).description("The molecule editor behind the composer's benzene button."),
  systemPrompt: Schema.boolean().default(true).description("Register the prompt section that teaches the model when to use each tool.")
});

// src/bootstrap.ts
import { mkdir as mkdir2, readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { platform } from "node:process";

// src/worker.ts
var WorkerError = class extends Error {
  /** Stable machine-readable tag, e.g. `invalid_smiles`, `timeout`, `busy`. */
  kind;
  /** Diagnostic tail (usually the child's stderr), when one is available. */
  detail;
  constructor(kind, message, detail) {
    super(message);
    this.name = "WorkerError";
    this.kind = kind;
    this.detail = detail;
  }
};
var SPAWN_FAILURE_LIMIT = 3;
var READY_TIMEOUT_MS = 3e4;
var SynomegaWorker = class {
  #handle;
  #starting;
  #buffer = "";
  #nextId = 1;
  #pending = /* @__PURE__ */ new Map();
  #queue = [];
  #draining = false;
  /** Requests dequeued and not yet settled, abandoned ones included: the worker is still busy with them. */
  #active = 0;
  #idleTimer;
  #killTimer;
  #spawnFailures = 0;
  #disposed = false;
  #startupStderr = "";
  #ctx;
  #config;
  #resolveEnvironment;
  constructor(ctx, config, resolveEnvironment) {
    this.#ctx = ctx;
    this.#config = config;
    this.#resolveEnvironment = resolveEnvironment;
  }
  /** Requests waiting for a slot; exposed for admission control and tests. */
  get queueDepth() {
    return this.#queue.length;
  }
  /** Whether a child process is currently alive. */
  get running() {
    return this.#handle !== void 0;
  }
  /**
   * Run one operation on the worker.
   * @param op - worker operation name.
   * @param params - operation parameters, already JSON-safe.
   * @param signal - caller cancellation; aborting abandons the call.
   * @param timeoutMs - cooperative deadline for this call.
   * @returns the operation's canonical value.
   */
  async call(op, params, signal, timeoutMs) {
    if (this.#disposed) throw new WorkerError("unavailable", "the SynOmega plugin is shutting down");
    const outstanding = this.#queue.length + this.#active;
    if (outstanding >= this.#config.queueLimit) {
      throw new WorkerError(
        "busy",
        `SynOmega is busy: ${outstanding} request(s) already outstanding. Retry after the current prediction finishes.`
      );
    }
    return await new Promise((resolve2, reject) => {
      this.#queue.push({ op, params, timeoutMs, signal, resolve: resolve2, reject });
      void this.#drain();
    });
  }
  /** Stop the worker and fail everything outstanding. */
  async dispose() {
    this.#disposed = true;
    this.#clearTimer("idle");
    this.#clearTimer("kill");
    const shuttingDown = new WorkerError("unavailable", "the SynOmega plugin was unloaded");
    for (const entry of this.#queue.splice(0)) entry.reject(shuttingDown);
    this.#failAllPending(shuttingDown);
    await this.#stop();
  }
  // ------------------------------------------------------------------ queue
  async #drain() {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#queue.length > 0 && !this.#disposed) {
        const entry = this.#queue.shift();
        if (entry === void 0) break;
        if (entry.signal.aborted) {
          entry.reject(new WorkerError("aborted", "the call was cancelled before it started"));
          continue;
        }
        this.#active += 1;
        try {
          await this.#run(entry);
        } finally {
          this.#active -= 1;
        }
      }
    } finally {
      this.#draining = false;
      this.#armIdleTimer();
    }
  }
  async #run(entry) {
    let handle;
    try {
      handle = await this.#startWithin(entry);
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const id = String(this.#nextId++);
    const settled = new Promise((resolve2, reject) => {
      const pending = { op: entry.op, resolve: resolve2, reject, timer: void 0, abandonedAt: void 0 };
      pending.timer = setTimeout(() => {
        this.#abandon(id, new WorkerError(
          "timeout",
          `${entry.op} exceeded ${Math.round(entry.timeoutMs / 1e3)}s. Try a smaller max_depth / max_steps, or raise the timeout in the plugin config.`
        ));
      }, entry.timeoutMs);
      this.#pending.set(id, pending);
    });
    const onAbort = () => {
      this.#abandon(id, new WorkerError("aborted", `${entry.op} was cancelled`));
    };
    entry.signal.addEventListener("abort", onAbort, { once: true });
    try {
      handle.stdin?.write(`${JSON.stringify({ id, op: entry.op, params: entry.params })}
`);
      entry.resolve(await settled);
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      entry.signal.removeEventListener("abort", onAbort);
    }
  }
  /** Await the child's readiness, bounded by this caller's deadline and signal. */
  async #startWithin(entry) {
    let timer;
    const bound = new Promise((_resolve, reject) => {
      const fail = (error) => reject(error);
      timer = setTimeout(() => fail(new WorkerError(
        "timeout",
        `the SynOmega Python worker did not become ready within ${Math.round(entry.timeoutMs / 1e3)}s`
      )), entry.timeoutMs);
      timer.unref?.();
      entry.signal.addEventListener(
        "abort",
        () => fail(new WorkerError("aborted", `${entry.op} was cancelled while the worker was starting`)),
        { once: true }
      );
    });
    try {
      return await Promise.race([this.#ensureStarted(), bound]);
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  /**
   * Settle a caller now and stop waiting for the reply. The worker keeps
   * computing; its answer is dropped when it arrives.
   */
  #abandon(id, error) {
    const pending = this.#pending.get(id);
    if (pending === void 0 || pending.abandonedAt !== void 0) return;
    if (pending.timer !== void 0) clearTimeout(pending.timer);
    pending.timer = void 0;
    pending.abandonedAt = Date.now();
    pending.reject(error);
    this.#armKillTimer();
  }
  #failAllPending(error) {
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== void 0) clearTimeout(pending.timer);
      this.#pending.delete(id);
      if (pending.abandonedAt === void 0) pending.reject(error);
    }
  }
  // ----------------------------------------------------------------- process
  async #ensureStarted() {
    if (this.#handle !== void 0) return this.#handle;
    if (this.#starting !== void 0) return await this.#starting;
    if (this.#spawnFailures >= SPAWN_FAILURE_LIMIT) {
      throw new WorkerError(
        "unavailable",
        `the SynOmega Python worker failed to start ${this.#spawnFailures} times in a row; it will not be retried until the plugin reloads`,
        this.#startupStderr
      );
    }
    this.#starting = this.#start();
    try {
      return await this.#starting;
    } finally {
      this.#starting = void 0;
    }
  }
  async #start() {
    const environment = await this.#resolveEnvironment();
    let handle;
    try {
      handle = this.#ctx.subprocess.spawn({
        argv: [environment.executable, "-u", `${environment.workerDir}/worker.py`],
        cwd: environment.workerDir,
        stdio: { stdin: "pipe", stdout: "pipe", stderr: { maxBytes: 64 * 1024 } },
        graceMs: 5e3,
        env: environment.env
      });
    } catch (error) {
      this.#spawnFailures += 1;
      throw new WorkerError("unavailable", `could not start the SynOmega Python worker: ${String(error)}`);
    }
    handle.stdout?.setEncoding("utf8");
    handle.stdout?.on("data", (chunk) => this.#onStdout(chunk));
    void handle.done.then(
      (outcome) => {
        const how = outcome.signal !== null ? `was killed by ${outcome.signal}` : `exited with code ${String(outcome.exitCode)}`;
        this.#onExit(how, handle);
      },
      (error) => this.#onExit(`failed to spawn: ${String(error)}`, handle)
    );
    this.#handle = handle;
    try {
      await this.#waitForReady(handle);
    } catch (error) {
      this.#spawnFailures += 1;
      this.#startupStderr = this.#readStderr(handle);
      handle.terminate();
      this.#handle = void 0;
      throw error;
    }
    this.#spawnFailures = 0;
    return handle;
  }
  /**
   * The child's stderr tail, for attaching to a failure message. Diagnostics are
   * collected in memory only (no spill file): a wedged interpreter's last words
   * are worth reporting, a full transcript is not worth a file.
   */
  #readStderr(handle) {
    try {
      return handle.collected.stderr?.readFrom(0).text.trim() ?? "";
    } catch {
      return "";
    }
  }
  /**
   * Wait for the worker's `ready` line. Blocking here converts "the interpreter
   * is broken" into a spawn failure now, instead of a request timeout minutes
   * later with no interpreter diagnostics attached.
   */
  async #waitForReady(handle) {
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(new WorkerError(
          "unavailable",
          "the SynOmega Python worker did not report ready within 30s",
          this.#readStderr(handle)
        ));
      }, READY_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([this.#ready, timeout]);
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  }
  #readyResolve;
  #ready = new Promise((resolve2) => {
    this.#readyResolve = resolve2;
  });
  #onStdout(chunk) {
    this.#buffer += chunk;
    let index = this.#buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.#buffer.slice(0, index).trim();
      this.#buffer = this.#buffer.slice(index + 1);
      if (line.length > 0) this.#onFrame(line);
      index = this.#buffer.indexOf("\n");
    }
  }
  #onFrame(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      this.#ctx.logger?.warn?.("synomega worker emitted a non-JSON line: %s", line.slice(0, 200));
      return;
    }
    if (typeof frame !== "object" || frame === null) return;
    const record = frame;
    if (record["event"] === "ready") {
      this.#readyResolve?.();
      return;
    }
    const id = typeof record["id"] === "string" ? record["id"] : void 0;
    if (id === void 0) return;
    const pending = this.#pending.get(id);
    if (pending === void 0) return;
    this.#pending.delete(id);
    if (pending.timer !== void 0) clearTimeout(pending.timer);
    if (pending.abandonedAt !== void 0) {
      this.#maybeClearKillTimer();
      return;
    }
    if (record["ok"] === true) {
      pending.resolve(record["data"] ?? null);
      return;
    }
    const error = record["error"] ?? {};
    pending.reject(new WorkerError(
      typeof error["kind"] === "string" ? error["kind"] : "internal",
      typeof error["message"] === "string" ? error["message"] : "the SynOmega worker reported an unspecified failure"
    ));
  }
  #onExit(reason, handle) {
    const stderr = this.#readStderr(handle);
    this.#handle = void 0;
    this.#buffer = "";
    this.#ready = new Promise((resolve2) => {
      this.#readyResolve = resolve2;
    });
    this.#clearTimer("kill");
    this.#failAllPending(new WorkerError(
      "unavailable",
      `the SynOmega Python worker ${reason}`,
      stderr
    ));
  }
  async #stop() {
    const handle = this.#handle;
    if (handle === void 0) return;
    this.#handle = void 0;
    const deadline = AbortSignal.timeout(this.#config.hardKillMs);
    try {
      handle.stdin?.write(`${JSON.stringify({ id: "shutdown", op: "shutdown" })}
`);
      handle.stdin?.end();
      await handle.waitForExit(deadline);
    } catch {
    } finally {
      handle.terminate();
    }
  }
  // ------------------------------------------------------------------ timers
  #armIdleTimer() {
    this.#clearTimer("idle");
    const idle = this.#config.workerIdleTimeoutMs;
    if (idle <= 0 || this.#handle === void 0) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#pending.size === 0 && this.#queue.length === 0) void this.#stop();
    }, idle);
    this.#idleTimer.unref?.();
  }
  #armKillTimer() {
    if (this.#killTimer !== void 0) return;
    this.#killTimer = setTimeout(() => {
      this.#killTimer = void 0;
      if (this.#hasAbandoned()) {
        this.#ctx.logger?.warn?.("synomega worker still busy with an abandoned call; restarting it");
        void this.#stop();
      }
    }, this.#config.hardKillMs);
    this.#killTimer.unref?.();
  }
  #maybeClearKillTimer() {
    if (!this.#hasAbandoned()) this.#clearTimer("kill");
  }
  #hasAbandoned() {
    for (const pending of this.#pending.values()) {
      if (pending.abandonedAt !== void 0) return true;
    }
    return false;
  }
  #clearTimer(which) {
    const timer = which === "idle" ? this.#idleTimer : this.#killTimer;
    if (timer !== void 0) clearTimeout(timer);
    if (which === "idle") this.#idleTimer = void 0;
    else this.#killTimer = void 0;
  }
};

// src/lock.ts
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
var STALE_MS = 2 * 60 * 6e4;
async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() })}
`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, payload, { flag: "wx" });
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          await rm(path, { force: true });
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const held2 = await describeLock(path);
    if (held2 === null) continue;
    if (held2.ageMs < STALE_MS) return held2;
    await rm(path, { force: true });
  }
  const held = await describeLock(path);
  return held ?? { held: true, pid: -1, ageMs: 0 };
}
async function describeLock(path) {
  try {
    const [info, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
    let pid = -1;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && typeof parsed.pid === "number") {
        pid = parsed.pid;
      }
    } catch {
    }
    return { held: true, pid, ageMs: Date.now() - info.mtimeMs };
  } catch {
    return null;
  }
}
function isHeld(result) {
  return "held" in result;
}

// src/bootstrap.ts
var PYTHON_CANDIDATES = ["python3.13", "python3.12", "python3.11", "python3.10"];
var UV_PYTHON = "3.12";
var STAMP_VERSION = 1;
var OTHER_PROVISIONER_WAIT_MS = 30 * 6e4;
var Bootstrap = class {
  #status = { phase: "idle", detail: "not started" };
  #promise;
  #ctx;
  #config;
  #stateDir;
  #workerDir;
  constructor(ctx, config, stateDir, workerDir) {
    this.#ctx = ctx;
    this.#config = config;
    this.#stateDir = stateDir;
    this.#workerDir = workerDir;
  }
  /** Current phase, for tools that need to explain a delay rather than fail. */
  describe() {
    return { ...this.#status };
  }
  /**
   * Resolve a usable Python environment, provisioning it if needed.
   *
   * Concurrent callers share one attempt. A failed attempt is not cached: the
   * next call retries, because the usual cause (no network, no interpreter) is
   * something the operator can fix without reloading the plugin.
   */
  async ensure() {
    if (this.#promise === void 0) {
      this.#promise = this.#provision().catch((error) => {
        this.#promise = void 0;
        const message = error instanceof Error ? error.message : String(error);
        this.#status = { phase: "failed", detail: "provisioning failed", error: message };
        throw error;
      });
    }
    return await this.#promise;
  }
  /** Kick provisioning off without waiting for it. Failures are logged, not thrown. */
  start() {
    if (!this.#config.autoSetup) {
      this.#status = { phase: "idle", detail: "autoSetup is off; the interpreter is resolved on first use" };
      return;
    }
    void this.ensure().catch((error) => {
      this.#ctx.logger?.warn?.("synomega bootstrap failed: %s", String(error));
    });
  }
  // ------------------------------------------------------------ provisioning
  async #provision() {
    await mkdir2(this.#stateDir, { recursive: true });
    const environmentOf = (executable) => ({
      executable,
      workerDir: this.#workerDir,
      env: this.#assetEnvironment()
    });
    const ready = await this.#readyStamp();
    if (ready !== null) return environmentOf(ready.executable);
    const lock = await acquireLock(join(this.#stateDir, "setup.lock"));
    if (isHeld(lock)) {
      this.#status = {
        phase: "installing",
        detail: `another process (pid ${lock.pid}) is provisioning SynOmega; waiting for it`
      };
      const finished = await this.#awaitOtherProvisioner();
      if (finished !== null) return environmentOf(finished.executable);
      throw new WorkerError(
        "setup_busy",
        `SynOmega is being provisioned by another process (pid ${lock.pid}) and has not finished yet. Retry shortly.`
      );
    }
    try {
      return await this.#provisionLocked(environmentOf);
    } finally {
      await lock.release();
    }
  }
  /** The stamp, when it describes a usable environment. */
  async #readyStamp() {
    const stamp = await this.#readStamp();
    if (stamp === null || !existsSync(stamp.executable)) return null;
    this.#status = {
      phase: "ready",
      detail: `synomega ${stamp.synomegaVersion} on Python ${stamp.pythonVersion}`
    };
    return stamp;
  }
  /**
   * Wait for whoever holds the lock to publish a stamp.
   *
   * Bounded: a holder that dies without releasing would otherwise block every
   * later call until its lock goes stale.
   */
  async #awaitOtherProvisioner() {
    const deadline = Date.now() + OTHER_PROVISIONER_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve2) => {
        setTimeout(resolve2, 3e3).unref?.();
      });
      const ready = await this.#readyStamp();
      if (ready !== null) return ready;
    }
    return null;
  }
  async #provisionLocked(environmentOf) {
    const ready = await this.#readyStamp();
    if (ready !== null) return environmentOf(ready.executable);
    this.#status = { phase: "resolving-python", detail: "looking for a Python 3.10+ interpreter" };
    const executable = await this.#resolveInterpreter();
    this.#status = {
      phase: "installing",
      detail: `installing synomega${this.#extrasSuffix()} (this can take several minutes)`
    };
    await this.#install(executable);
    const synomegaVersion = await this.#importedVersion(executable);
    let assetsReady = false;
    if (this.#config.downloadAssets) {
      this.#status = {
        phase: "downloading-assets",
        detail: "downloading the default model and building-block stock (a few hundred MB, once)"
      };
      assetsReady = await this.#downloadAssets(executable);
    }
    const pythonVersion = await this.#interpreterVersion(executable);
    await this.#writeStamp({
      stampVersion: STAMP_VERSION,
      executable,
      pythonVersion,
      synomegaVersion,
      extras: [...this.#config.extras],
      assetsReady,
      at: (/* @__PURE__ */ new Date()).toISOString()
    });
    this.#status = { phase: "ready", detail: `synomega ${synomegaVersion} on Python ${pythonVersion}` };
    return environmentOf(executable);
  }
  async #resolveInterpreter() {
    if (this.#config.python !== void 0 && this.#config.python.length > 0) {
      return this.#config.python;
    }
    const venv = this.#config.venvDir ?? join(this.#stateDir, "venv");
    const executable = venvPython(venv);
    if (existsSync(executable)) return executable;
    if (await this.#hasCommand("uv")) {
      const created = await this.#run(["uv", "venv", "--python", UV_PYTHON, venv]);
      if (created.exitCode === 0 && existsSync(executable)) return executable;
      this.#ctx.logger?.warn?.("uv venv failed: %s", created.stderr.slice(-2e3));
    }
    for (const candidate of PYTHON_CANDIDATES) {
      if (!await this.#hasCommand(candidate)) continue;
      const created = await this.#run([candidate, "-m", "venv", venv]);
      if (created.exitCode === 0 && existsSync(executable)) return executable;
    }
    throw new WorkerError(
      "no_python",
      "SynOmega needs Python 3.10 or newer and none was found. Install uv (https://docs.astral.sh/uv/) and reload the plugin \u2014 uv will fetch a suitable interpreter itself \u2014 or set the plugin's `python` config to an existing 3.10+ interpreter."
    );
  }
  async #install(executable) {
    const requirement = `synomega${this.#extrasSuffix()}`;
    const useUv = await this.#hasCommand("uv");
    const argv = useUv ? ["uv", "pip", "install", "--python", executable, requirement] : [executable, "-m", "pip", "install", requirement];
    const result = await this.#run(argv, 30 * 6e4);
    if (result.exitCode !== 0) {
      throw new WorkerError(
        "install_failed",
        `installing ${requirement} failed (exit ${String(result.exitCode)}). ${lastLine(result.stderr)}`,
        result.stderr.slice(-4e3)
      );
    }
  }
  async #downloadAssets(executable) {
    const result = await this.#run(
      [executable, "-c", 'from synomega.cli import main; raise SystemExit(main(["download"]))'],
      60 * 6e4
    );
    if (result.exitCode === 0) {
      const forward = await this.#run(
        [executable, "-c", "from synomega.forward import ForwardTemplateGNN; ForwardTemplateGNN.default()"],
        60 * 6e4
      );
      if (forward.exitCode !== 0) {
        this.#ctx.logger?.warn?.(
          "synomega forward-model prefetch failed (exit %s); it will download on the first forward prediction. %s",
          String(forward.exitCode),
          lastLine(forward.stderr)
        );
      }
      return true;
    }
    this.#ctx.logger?.warn?.(
      "synomega asset prefetch failed (exit %s); assets will download on first use instead. %s",
      String(result.exitCode),
      lastLine(result.stderr)
    );
    return false;
  }
  async #importedVersion(executable) {
    const result = await this.#run([executable, "-c", "import synomega; print(synomega.__version__)"]);
    if (result.exitCode !== 0) {
      throw new WorkerError(
        "install_failed",
        `synomega installed but is not importable. ${lastLine(result.stderr)}`,
        result.stderr.slice(-4e3)
      );
    }
    return result.stdout.trim();
  }
  async #interpreterVersion(executable) {
    const result = await this.#run([
      executable,
      "-c",
      'import sys; print("%d.%d.%d" % sys.version_info[:3])'
    ]);
    return result.exitCode === 0 ? result.stdout.trim() : "unknown";
  }
  // ------------------------------------------------------------------ plumbing
  /** Environment entries SynOmega reads for asset resolution. */
  #assetEnvironment() {
    const env = {};
    if (this.#config.mirror !== "auto") env["SYNOMEGA_MIRROR"] = this.#config.mirror;
    if (this.#config.cacheDir !== void 0) env["SYNOMEGA_CACHE"] = this.#config.cacheDir;
    return env;
  }
  #extrasSuffix() {
    const extras = this.#config.extras.filter((extra) => extra.trim().length > 0);
    return extras.length > 0 ? `[${extras.join(",")}]` : "";
  }
  async #hasCommand(command) {
    try {
      await this.#ctx.subprocess.resolveExecutable(command);
      return true;
    } catch {
      return false;
    }
  }
  async #run(argv, timeoutMs = 10 * 6e4) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const handle = this.#ctx.subprocess.spawn({
        argv,
        cwd: this.#stateDir,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 256 * 1024 },
          stderr: { maxBytes: 256 * 1024 }
        },
        graceMs: 5e3,
        signal: controller.signal,
        env: this.#assetEnvironment()
      });
      const outcome = await handle.done;
      return {
        exitCode: outcome.exitCode,
        stdout: handle.collected.stdout?.readFrom(0).text ?? "",
        stderr: handle.collected.stderr?.readFrom(0).text ?? ""
      };
    } catch (error) {
      return { exitCode: null, stdout: "", stderr: String(error) };
    } finally {
      clearTimeout(timer);
    }
  }
  #stampPath() {
    return join(this.#stateDir, "state.json");
  }
  async #readStamp() {
    let raw;
    try {
      raw = await readFile2(this.#stampPath(), "utf8");
    } catch {
      return null;
    }
    let stamp;
    try {
      stamp = JSON.parse(raw);
    } catch {
      return null;
    }
    if (stamp.stampVersion !== STAMP_VERSION) return null;
    if (!sameExtras(stamp.extras, this.#config.extras)) return null;
    if (this.#config.downloadAssets && !stamp.assetsReady) return null;
    return stamp;
  }
  async #writeStamp(stamp) {
    await writeFile2(this.#stampPath(), `${JSON.stringify(stamp, null, 2)}
`, "utf8");
  }
};
function venvPython(venvDir) {
  return platform === "win32" ? join(venvDir, "Scripts", "python.exe") : join(venvDir, "bin", "python");
}
function sameExtras(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function lastLine(text2) {
  const lines = text2.trimEnd().split("\n");
  return lines[lines.length - 1]?.trim() ?? "";
}

// src/tools/singlestep.ts
import { defineTool } from "@deepseek-ai/dsh-tools";

// src/tools/shared.ts
function text(body) {
  return [{ type: "text", text: body }];
}
async function runOp(deps, op, params, exec, timeoutMs) {
  const status = deps.bootstrap.describe();
  if (status.phase === "installing" || status.phase === "downloading-assets") {
    throw new Error(
      `SynOmega is still being set up: ${status.detail}. This happens once; retry in a minute rather than falling back to another approach.`
    );
  }
  const cleaned = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== void 0) cleaned[key] = value;
  }
  try {
    return await deps.worker.call(op, cleaned, exec.signal, timeoutMs);
  } catch (error) {
    throw describeFailure(error);
  }
}
function describeFailure(error) {
  if (!(error instanceof WorkerError)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const detail = error.detail !== void 0 && error.detail.length > 0 ? `
--- python stderr (tail) ---
${error.detail}` : "";
  return new Error(`${error.message}${detail}`);
}
function boundTree(root, maxNodes) {
  if (!isTreeNode(root)) return { tree: null, truncated: 0 };
  let budget = Math.max(1, maxNodes);
  let dropped = 0;
  const copy = (node) => {
    const out = { type: node.type, smiles: node.smiles };
    if (node.in_stock !== void 0) out.in_stock = node.in_stock;
    if (node.depth !== void 0) out.depth = node.depth;
    if (node.score !== void 0) out.score = node.score;
    if (node.template_id !== void 0) out.template_id = node.template_id;
    return out;
  };
  const rootCopy = copy(root);
  budget -= 1;
  const queue = [[root, rootCopy]];
  while (queue.length > 0) {
    const entry = queue.shift();
    if (entry === void 0) break;
    const [source, target] = entry;
    const children = Array.isArray(source.children) ? source.children : [];
    const kept = [];
    for (const child of children) {
      if (!isTreeNode(child)) continue;
      if (budget <= 0) {
        dropped += countNodes(child);
        continue;
      }
      budget -= 1;
      const childCopy = copy(child);
      kept.push(childCopy);
      queue.push([child, childCopy]);
    }
    if (kept.length > 0) target.children = kept;
  }
  return { tree: rootCopy, truncated: dropped };
}
function countNodes(node) {
  const children = Array.isArray(node.children) ? node.children : [];
  return 1 + children.reduce((sum, child) => sum + (isTreeNode(child) ? countNodes(child) : 0), 0);
}
function isTreeNode(value) {
  if (typeof value !== "object" || value === null) return false;
  const node = value;
  return (node["type"] === "mol" || node["type"] === "reaction") && typeof node["smiles"] === "string";
}
function describeRoute(root, limit = 25) {
  const lines = [];
  const walk = (node) => {
    if (!isTreeNode(node) || lines.length >= limit) return;
    if (node.type === "reaction") {
      const score = typeof node.score === "number" ? ` (score ${node.score.toFixed(4)})` : "";
      lines.push(`${node.smiles}${score}`);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return lines;
}
function missingLeaves(root) {
  const missing = [];
  const walk = (node) => {
    if (!isTreeNode(node)) return;
    const children = node.children ?? [];
    if (node.type === "mol" && children.length === 0 && node.in_stock === false) {
      missing.push(node.smiles);
    }
    for (const child of children) walk(child);
  };
  walk(root);
  return missing;
}
function field(value, key, fallback) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const found = value[key];
  return found === void 0 || found === null ? fallback : found;
}
function asCanonical(value) {
  return value;
}

// src/tools/singlestep.ts
function retroTool(deps) {
  return defineTool({
    name: "synomega_retro",
    description: 'Single-step retrosynthesis: given a PRODUCT (SMILES), rank one-step disconnections into candidate reactant sets. Use for "what reacts to give X?" or "how could this bond be formed?". For a full route down to purchasable material use synomega_plan instead.',
    parameters: {
      product: {
        type: "string",
        required: true,
        description: "Product SMILES. Resolve a chemical name to SMILES before calling."
      },
      top_k: {
        type: "integer",
        description: "Candidate disconnections to return, 1-100. Default 10."
      },
      simplify: {
        type: "boolean",
        description: "Use the simplification-constrained model, which only proposes disconnections that split the target into two or more precursors. Default false."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string" },
          elapsed_s: { type: "number" },
          predictions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                rank: { type: "integer" },
                reactants: { type: "array", items: { type: "string" } },
                reaction_smiles: { type: "string", description: "reactants>>product" },
                score: { type: "number", description: "0-1, higher is more likely" },
                template_id: { oneOf: [{ type: "integer" }, { type: "null" }] },
                plausibility: {
                  oneOf: [{ type: "number" }, { type: "null" }],
                  description: "Null unless plausibility screening is enabled in the deployment."
                }
              }
            }
          }
        }
      },
      render: (args, value) => {
        const predictions = field(value, "predictions", []);
        if (predictions.length === 0) {
          return text(`No disconnection found for ${args.product}.`);
        }
        const lines = predictions.map((p) => {
          const plausibility = p.plausibility === null ? "" : `  plausibility ${p.plausibility.toFixed(2)}`;
          return `  ${p.rank}. ${p.reaction_smiles}  score ${p.score.toFixed(4)}${plausibility}`;
        });
        return text(
          `${predictions.length} disconnection(s) for ${args.product}, best first:
${lines.join("\n")}`
        );
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null;
        const predictions = field(value, "predictions", []);
        const shown = predictions.slice(0, deps.config.maxCardItems);
        return {
          kind: "retro",
          target: args.product,
          shown: shown.length,
          total: predictions.length,
          predictions: shown.map((p) => ({
            rank: p.rank,
            reactants: p.reactants,
            score: p.score,
            plausibility: p.plausibility
          }))
        };
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: `retrosynthesis \xB7 ${args.product}`,
      kind: "other",
      rawInput: args
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, "retro", {
        product: args.product,
        top_k: args.top_k,
        simplify: args.simplify ?? false,
        plausibility: deps.config.plausibility,
        plausibility_threshold: deps.config.plausibilityThreshold,
        algorithm: deps.config.algorithm
      }, exec, deps.config.timeouts.retro);
      return asCanonical(value);
    }
  });
}
function forwardTool(deps) {
  return defineTool({
    name: "synomega_forward",
    description: 'Single-step forward reaction prediction: given REACTANTS (dot-separated SMILES), rank the likely products. Use for "what do these reactants give?" or "what is the outcome of this reaction?". Predictions are template-based candidates, not guarantees.',
    parameters: {
      reactants: {
        type: "string",
        required: true,
        description: 'Reactant SMILES, dot-separated for multiple molecules, e.g. "CC(=O)O.NCc1ccccc1".'
      },
      top_k: { type: "integer", description: "Candidate products to return, 1-50. Default 5." }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reactants: { type: "string" },
          elapsed_s: { type: "number" },
          products: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                rank: { type: "integer" },
                product: { type: "string" },
                reaction_smiles: { type: "string" },
                score: { type: "number", description: "0-1 forward probability" },
                template_id: { oneOf: [{ type: "integer" }, { type: "null" }] }
              }
            }
          }
        }
      },
      render: (args, value) => {
        const products = field(value, "products", []);
        if (products.length === 0) {
          return text(`No product predicted for ${args.reactants}.`);
        }
        const lines = products.map((p) => `  ${p.rank}. ${p.product}  score ${p.score.toFixed(4)}`);
        return text(
          `${products.length} predicted product(s) from ${args.reactants}, best first:
${lines.join("\n")}`
        );
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null;
        const products = field(value, "products", []);
        const shown = products.slice(0, deps.config.maxCardItems);
        return {
          kind: "forward",
          reactants: args.reactants.split(".").filter((part) => part.length > 0),
          shown: shown.length,
          total: products.length,
          products: shown.map((p) => ({ rank: p.rank, product: p.product, score: p.score }))
        };
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: `forward prediction \xB7 ${args.reactants}`,
      kind: "other",
      rawInput: args
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, "forward", {
        reactants: args.reactants,
        top_k: args.top_k
      }, exec, deps.config.timeouts.forward);
      return asCanonical(value);
    }
  });
}

// src/tools/planning.ts
import { defineTool as defineTool2 } from "@deepseek-ai/dsh-tools";
function planTool(deps) {
  return defineTool2({
    name: "synomega_plan",
    description: 'Multi-step retrosynthetic route planning: search from a TARGET (SMILES) down to purchasable building blocks. Use for "how do I make X?" or "give me a synthetic route". Returns whole routes as nested reactions; `solved` says whether every starting material is purchasable.',
    parameters: {
      target: { type: "string", required: true, description: "Target product SMILES." },
      max_depth: { type: "integer", description: "Longest route allowed, 1-12. Default 5." },
      max_routes: { type: "integer", description: "Routes to return, best first, 1-25. Default 3." },
      exclude_target: {
        type: "boolean",
        description: "Treat the target as NOT purchasable even if it is a catalogue item, forcing a real disconnection. Use it when asked how a possibly-buyable molecule would actually be made."
      },
      simplify: {
        type: "boolean",
        description: "Search with the simplification-constrained model: fewer expansions to reach stock, at matched solvability. Default follows the deployment configuration."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          target: { type: "string" },
          algorithm: { type: "string" },
          solved: { type: "boolean", description: "A route whose leaves are all purchasable exists." },
          num_routes_found: { type: "integer" },
          stats: { type: "json", description: "expansions, model_calls, elapsed_s, terminated_by" },
          routes: {
            type: "array",
            description: "Best first. Each route is { solved, num_steps, depth, bb_coverage, cumulative_score, tree }, where `tree` alternates mol and reaction nodes: a mol node carries { smiles, in_stock, depth } and its single reaction child carries { smiles (reactants>>product), score, template_id } plus its reactant mol nodes.",
            items: { type: "json" }
          }
        }
      },
      render: (args, value) => {
        const routes = field(value, "routes", []);
        const solved = field(value, "solved", false);
        const stats = field(value, "stats", {});
        const header = `target ${args.target} \u2014 ${solved ? "solved" : "NOT solved"}, ${field(value, "num_routes_found", routes.length)} route(s) found (${String(stats["expansions"] ?? "?")} expansions, stopped by ${String(stats["terminated_by"] ?? "?")})`;
        if (routes.length === 0) {
          return text(
            `${header}
No route was extracted. Try a larger max_depth, or exclude_target if the target is itself a catalogue item.`
          );
        }
        const blocks = routes.map((route, index) => {
          const steps = describeRoute(route.tree).map((line, i) => `  [${i + 1}] ${line}`);
          const missing = missingLeaves(route.tree);
          const tail = missing.length > 0 ? `
  not purchasable: ${missing.join(", ")}` : "";
          return `route ${index + 1} (${route.num_steps} step(s), ${(route.bb_coverage * 100).toFixed(0)}% of leaves purchasable):
${steps.join("\n")}${tail}`;
        });
        return text(`${header}
${blocks.join("\n")}`);
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null;
        const routes = field(value, "routes", []);
        let truncated = 0;
        const projected = routes.map((route) => {
          const bounded = boundTree(route.tree, deps.config.maxTreeNodes);
          truncated += bounded.truncated;
          return {
            solved: route.solved,
            num_steps: route.num_steps,
            depth: route.depth,
            bb_coverage: route.bb_coverage,
            cumulative_score: route.cumulative_score,
            tree: bounded.tree
          };
        });
        return {
          kind: "plan",
          target: args.target,
          solved: field(value, "solved", false),
          algorithm: field(value, "algorithm", ""),
          routes: projected,
          // A tree that quietly lost branches would read as a complete route.
          truncatedNodes: truncated
        };
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: `route planning \xB7 ${args.target}`,
      kind: "other",
      rawInput: args
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, "plan", {
        target: args.target,
        max_depth: args.max_depth,
        max_routes: args.max_routes,
        exclude_target: args.exclude_target ?? false,
        simplify: args.simplify ?? deps.config.simplifyPlanning,
        algorithm: deps.config.algorithm,
        plausibility: deps.config.plausibility,
        plausibility_threshold: deps.config.plausibilityThreshold,
        time_limit: deps.config.search.timeLimitS,
        max_expansions: deps.config.search.maxExpansions
      }, exec, deps.config.timeouts.plan);
      return asCanonical(value);
    }
  });
}
function scoreTool(deps) {
  return defineTool2({
    name: "synomega_score",
    description: 'Synthesizability score (SynScore) for one TARGET: a continuous 0-1 number for how makeable it is, from one route search. Use to rank candidate molecules by ease of synthesis, or to answer "can this be made, and how hard is it?". score = 1/(U+1)^U where U is the number of non-purchasable starting materials in the best route: 1.0 solved, 0.5 one missing, 0.11 two, 0 no route at all. Use `solved` (boolean) to compare against published solve rates.',
    parameters: {
      target: { type: "string", required: true, description: "Target SMILES." },
      max_steps: { type: "integer", description: "Longest route allowed, 1-12. Default 5." },
      exclude_target: {
        type: "boolean",
        description: "Treat the target as not purchasable even if it is a catalogue item."
      },
      original: {
        type: "boolean",
        description: "Score with the unconstrained single-step model instead of the simplification-constrained one. The constrained model is the recommended scoring configuration; leave this off unless comparing the two."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          smiles: { type: "string" },
          score: { type: "number", description: "SynScore, 0-1; higher is easier to make." },
          solved: { type: "boolean" },
          bb_coverage: { type: "number", description: "Fraction of best-route leaves that are purchasable." },
          min_steps: { type: "integer" },
          min_route_depth: { type: "integer" },
          num_routes: { type: "integer" },
          num_leaves: { type: "integer" },
          num_purchasable_leaves: { type: "integer" },
          max_steps: { type: "integer" },
          elapsed_s: { type: "number" },
          expansions: { type: "integer" },
          terminated_by: { type: "string" },
          error: { oneOf: [{ type: "string" }, { type: "null" }] },
          best_route: { type: "json", description: "Same tree shape as synomega_plan, or null." }
        }
      },
      render: (args, value) => {
        const score = field(value, "score", 0);
        const solved = field(value, "solved", false);
        const leaves = field(value, "num_leaves", 0);
        const purchasable = field(value, "num_purchasable_leaves", 0);
        const missing = leaves - purchasable;
        const head = `${args.target}
SynScore ${score.toFixed(4)}  (${solved ? "solved" : "unsolved"}; ${missing} of ${leaves} starting material(s) not purchasable)
shortest route ${field(value, "min_steps", 0)} step(s), ${field(value, "num_routes", 0)} route(s), ${field(value, "expansions", 0)} expansions, stopped by ${field(value, "terminated_by", "?")}`;
        const route = field(value, "best_route", null);
        const steps = route === null ? [] : describeRoute(route).map((line, i) => `  [${i + 1}] ${line}`);
        return text(steps.length > 0 ? `${head}
best route:
${steps.join("\n")}` : head);
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null;
        const bounded = boundTree(field(value, "best_route", null), deps.config.maxTreeNodes);
        return {
          kind: "score",
          target: args.target,
          score: field(value, "score", 0),
          solved: field(value, "solved", false),
          bbCoverage: field(value, "bb_coverage", 0),
          minSteps: field(value, "min_steps", 0),
          numLeaves: field(value, "num_leaves", 0),
          numPurchasableLeaves: field(value, "num_purchasable_leaves", 0),
          bestRoute: bounded.tree,
          truncatedNodes: bounded.truncated
        };
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: `synthesizability \xB7 ${args.target}`,
      kind: "other",
      rawInput: args
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, "score", {
        target: args.target,
        max_steps: args.max_steps,
        exclude_target: args.exclude_target ?? false,
        original: args.original ?? false,
        time_limit: deps.config.search.timeLimitS,
        max_expansions: deps.config.search.maxExpansions
      }, exec, deps.config.timeouts.score);
      return asCanonical(value);
    }
  });
}

// src/tools/evolution.ts
import { defineTool as defineTool3 } from "@deepseek-ai/dsh-tools";
function evolveTool(deps) {
  return defineTool3({
    name: "synomega_evolve",
    description: 'Multi-component evolution: from a set of REACTANTS (dot-separated SMILES, at least two), repeatedly react pairs with the forward model and grow a synthesis network. Use for one-pot / multicomponent chemistry, or "what can this mixture form?". Not a route planner: for a route to a known target use synomega_plan.',
    parameters: {
      reactants: {
        type: "string",
        required: true,
        description: 'At least two dot-separated reactant SMILES, e.g. "CC(=O)c1ccccc1.C=O.CNC".'
      },
      max_depth: {
        type: "integer",
        description: "Rounds of pairing, 1-8. Default 3. Each round multiplies the pool, so raise it slowly."
      },
      score_threshold: {
        type: "number",
        description: "Drop products whose cumulative score falls below this, 0-1. Default 0.01."
      },
      top: { type: "integer", description: "Molecules to report, best first, 1-500. Default 20." },
      forward_top_k: { type: "integer", description: "Products kept per reactant pair, 1-25. Default 5." },
      frontier_width: {
        type: "integer",
        description: "Cap the fan-out per round. Useful when the starting pool is large."
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reactants: { type: "array", items: { type: "string" } },
          stats: { type: "json", description: "rounds, num_reactions and other run facts" },
          num_molecules: { type: "integer", description: "Distinct molecules in the whole network." },
          num_reaction_edges: { type: "integer" },
          molecules: {
            type: "array",
            description: "Best first, capped by `top`.",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                smiles: { type: "string" },
                total_score: {
                  type: "number",
                  description: "min(parent totals) x step probability; starting reactants are 1.0."
                },
                depth: { type: "integer", description: "Synthesis-tree depth from the starting pool." },
                step_score: { oneOf: [{ type: "number" }, { type: "null" }] },
                parents: {
                  oneOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
                  description: "The two molecules that reacted; null for a starting reactant."
                },
                template_id: { oneOf: [{ type: "integer" }, { type: "null" }] }
              }
            }
          }
        }
      },
      render: (args, value) => {
        const molecules = field(value, "molecules", []);
        const total = field(value, "num_molecules", molecules.length);
        const edges = field(value, "num_reaction_edges", 0);
        const header = `evolved ${args.reactants} \u2014 ${total} distinct molecule(s), ${edges} reaction edge(s)` + (molecules.length < total ? `; showing the top ${molecules.length}` : "");
        if (molecules.length === 0) return text(`${header}
Nothing above the score threshold.`);
        const lines = molecules.map((molecule) => {
          const origin = molecule.parents === null ? "starting reactant" : `${molecule.parents.join(" + ")}`;
          return `  ${molecule.smiles}  score ${molecule.total_score.toFixed(4)}  depth ${molecule.depth}  <- ${origin}`;
        });
        return text(`${header}
${lines.join("\n")}`);
      },
      presentationMeta: (args, value) => {
        if (!deps.config.visualize) return null;
        const molecules = field(value, "molecules", []);
        const shown = molecules.slice(0, Math.max(deps.config.maxCardItems, 24));
        return {
          kind: "evolve",
          reactants: field(value, "reactants", []),
          numMolecules: field(value, "num_molecules", molecules.length),
          numReactionEdges: field(value, "num_reaction_edges", 0),
          shown: shown.length,
          total: molecules.length,
          molecules: shown.map((molecule) => ({
            smiles: molecule.smiles,
            totalScore: molecule.total_score,
            depth: molecule.depth,
            parents: molecule.parents
          }))
        };
      }
    },
    presentCall: (args) => ({
      card: "generic",
      title: `evolution \xB7 ${args.reactants}`,
      kind: "other",
      rawInput: args
    }),
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const value = await runOp(deps, "evolve", {
        reactants: args.reactants,
        max_depth: args.max_depth,
        score_threshold: args.score_threshold,
        top: args.top,
        forward_top_k: args.forward_top_k,
        frontier_width: args.frontier_width
      }, exec, deps.config.timeouts.evolve);
      return asCanonical(value);
    }
  });
}

// src/prompt.ts
var SYNOMEGA_SECTION_ORDER = 140;
var SYNOMEGA_SECTION_NAME = "synomega:tool-guidance";
var SYNOMEGA_GUIDANCE = `## Chemistry: SynOmega tools

Five tools predict organic reactions locally. Match the tool to the question:

- "how do I make X" / "give me a route" -> synomega_plan
- "can X be made" / "rank these by ease of synthesis" -> synomega_score (SynScore, 0-1)
- "what reacts to give X" / "how is this bond formed" -> synomega_retro
- "what do these reactants give" / "what is the outcome" -> synomega_forward
- "what can this mixture form" / one-pot or multicomponent chemistry -> synomega_evolve

Rules:
- Every molecule argument is a SMILES string. If the user gives a name, resolve it to SMILES first, or ask. Dot-separate multiple molecules.
- Start at the default depth and top-k. Raise them only when the default finds nothing; larger budgets are much slower.
- The first call after installation downloads a few hundred MB of model weights and can take minutes. If a tool says setup is in progress, wait and retry rather than switching approach.
- Predictions are ranked candidates, not guarantees. Report scores alongside structures, and say when a route is unsolved rather than presenting a partial route as complete.
- Retrosynthesis is dual-use. General or educational discussion of chemistry differs from actionable route and procurement assistance for a specific hazardous, controlled, or weaponizable target. For high-risk targets, defer to this deployment's safety policy instead of planning on autopilot; surface the concern when a request looks like it seeks a usable route to a dangerous substance.`;

// src/ketcher.ts
import { createHash } from "node:crypto";
import { existsSync as existsSync2 } from "node:fs";
import { mkdir as mkdir3, readFile as readFile3, rm as rm2, stat as stat2, writeFile as writeFile3 } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname as dirname2, join as join2, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// src/zip.ts
import { crc32, inflateRaw } from "node:zlib";
import { promisify } from "node:util";
var inflateRawAsync = promisify(inflateRaw);
var EOCD_SIGNATURE = 101010256;
var CENTRAL_SIGNATURE = 33639248;
var LOCAL_SIGNATURE = 67324752;
var MAX_COMMENT = 65535;
function readEntries(archive) {
  const eocd = findEndOfCentralDirectory(archive);
  const disk = archive.readUInt16LE(eocd + 4);
  const count = archive.readUInt16LE(eocd + 10);
  const size = archive.readUInt32LE(eocd + 12);
  const start = archive.readUInt32LE(eocd + 16);
  if (disk !== 0) throw new Error("zip: multi-disk archives are not supported");
  if (count === 65535 || size === 4294967295 || start === 4294967295) {
    throw new Error("zip: ZIP64 archives are not supported");
  }
  const entries = [];
  let cursor = start;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > archive.length) throw new Error("zip: central directory runs past the end of the archive");
    if (archive.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) throw new Error("zip: corrupt central directory");
    const flags = archive.readUInt16LE(cursor + 8);
    if ((flags & 1) !== 0) throw new Error("zip: encrypted archives are not supported");
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    entries.push({
      name: archive.toString("utf8", cursor + 46, cursor + 46 + nameLength),
      method: archive.readUInt16LE(cursor + 10),
      crc: archive.readUInt32LE(cursor + 16),
      compressedSize: archive.readUInt32LE(cursor + 20),
      uncompressedSize: archive.readUInt32LE(cursor + 24),
      offset: archive.readUInt32LE(cursor + 42)
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
async function readEntry(archive, entry) {
  if (entry.offset + 30 > archive.length) throw new Error(`zip: ${entry.name} points past the end of the archive`);
  if (archive.readUInt32LE(entry.offset) !== LOCAL_SIGNATURE) throw new Error(`zip: ${entry.name} has no local header`);
  const nameLength = archive.readUInt16LE(entry.offset + 26);
  const extraLength = archive.readUInt16LE(entry.offset + 28);
  const start = entry.offset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > archive.length) throw new Error(`zip: ${entry.name} is truncated`);
  const raw = archive.subarray(start, end);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = await inflateRawAsync(raw);
  else throw new Error(`zip: ${entry.name} uses compression method ${entry.method}, which is not supported`);
  if (data.length !== entry.uncompressedSize) {
    throw new Error(`zip: ${entry.name} decompressed to ${data.length} bytes, expected ${entry.uncompressedSize}`);
  }
  if (crc32(data) !== entry.crc) throw new Error(`zip: ${entry.name} failed its checksum`);
  return data;
}
function isSafeEntryName(name2) {
  if (name2.length === 0 || name2.length > 1024) return false;
  if (name2.startsWith("/") || name2.includes("\\") || name2.includes("\0")) return false;
  if (/^[a-zA-Z]:/.test(name2)) return false;
  return !name2.split("/").includes("..");
}
function findEndOfCentralDirectory(archive) {
  const earliest = Math.max(0, archive.length - MAX_COMMENT - 22);
  for (let at = archive.length - 22; at >= earliest; at -= 1) {
    if (archive.readUInt32LE(at) === EOCD_SIGNATURE) return at;
  }
  throw new Error("zip: not a zip archive (no end-of-central-directory record)");
}

// src/shared/ketcher.ts
var KETCHER_ROUTE = "/dsh-synomega/ketcher";
var KETCHER_STATE_PATH = `${KETCHER_ROUTE}/__state`;
var KETCHER_APP_PATH = `${KETCHER_ROUTE}/index.html`;

// src/ketcher.ts
var KNOWN_DIGESTS = {
  "3.17.0": "4aab6395054bd77b1e068dbd8463f462846a7b25879117a251e5693f682275ed"
};
function defaultArchiveUrl(version) {
  return `https://github.com/epam/ketcher/releases/download/v${version}/ketcher-standalone-${version}.zip`;
}
var MIRRORS = {
  "3.17.0": [
    "https://git.ustc.edu.cn/-/project/9893/uploads/e3463c809d5927755c1414ba06146c69/ketcher-standalone-3.17.0.zip"
  ]
};
function archiveUrls(version) {
  return [defaultArchiveUrl(version), ...MIRRORS[version] ?? []];
}
var UNUSED_ENTRIES = ["duo.", "popup.", "closable."];
var STAMP = ".ready.json";
var CONNECT_TIMEOUT_MS = 2e4;
var OTHER_PROVISIONER_WAIT_MS2 = 20 * 6e4;
var CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf"
};
var KetcherAssets = class {
  #state;
  #promise;
  #ctx;
  #config;
  #stateDir;
  constructor(ctx, config, stateDir) {
    this.#ctx = ctx;
    this.#config = config;
    this.#stateDir = stateDir;
    this.#state = config.ketcher.enabled ? { phase: "idle", detail: "not downloaded yet", version: config.ketcher.version } : { phase: "disabled", detail: "the molecule editor is turned off in this deployment", version: config.ketcher.version };
  }
  /** Directory the chosen version is extracted into. */
  get root() {
    return join2(this.#stateDir, "ketcher", this.#config.ketcher.version);
  }
  /** Current phase — what the browser half polls while its dialog is open. */
  describe() {
    return { ...this.#state };
  }
  /**
   * Make the editor available, downloading and extracting it if needed.
   *
   * Concurrent callers share one attempt, and a failed attempt is not cached:
   * the usual cause is a network that will be back.
   */
  async ensure() {
    if (!this.#config.ketcher.enabled) throw new Error("the molecule editor is turned off in this deployment");
    if (this.#promise === void 0) {
      this.#promise = this.#provision().catch((error) => {
        this.#promise = void 0;
        const message = error instanceof Error ? error.message : String(error);
        this.#state = { ...this.#state, phase: "failed", detail: message };
        throw error;
      });
    }
    return await this.#promise;
  }
  /** Kick provisioning off without waiting for it; failures land in {@link describe}. */
  start() {
    if (!this.#config.ketcher.enabled || !this.#config.ketcher.prefetch) return;
    void this.ensure().catch((error) => {
      this.#ctx.logger?.warn?.("synomega: ketcher prefetch failed: %s", String(error));
    });
  }
  async #provision() {
    if (existsSync2(join2(this.root, STAMP))) {
      this.#state = { ...this.#state, phase: "ready", detail: "ready" };
      return this.root;
    }
    const lockPath = join2(this.#stateDir, "ketcher", "provision.lock");
    const lock = await acquireLock(lockPath);
    if (isHeld(lock)) {
      this.#state = { ...this.#state, phase: "downloading", detail: `another process (pid ${lock.pid}) is installing the editor` };
      await this.#awaitOtherProvisioner();
      this.#state = { ...this.#state, phase: "ready", detail: "ready" };
      return this.root;
    }
    try {
      await this.#provisionLocked();
      return this.root;
    } finally {
      await lock.release();
    }
  }
  async #provisionLocked() {
    if (existsSync2(join2(this.root, STAMP))) {
      this.#state = { ...this.#state, phase: "ready", detail: "ready" };
      return;
    }
    const version = this.#config.ketcher.version;
    const candidates = this.#config.ketcher.url === void 0 ? archiveUrls(version) : [this.#config.ketcher.url];
    this.#state = { ...this.#state, phase: "downloading", detail: `downloading Ketcher ${version} (about 35 MB)` };
    const expected = this.#config.ketcher.url === void 0 ? KNOWN_DIGESTS[version] : void 0;
    let url = candidates[0];
    let archive;
    const failures = [];
    for (const candidate of candidates) {
      try {
        const body = await download(candidate);
        if (expected !== void 0) {
          const actual = createHash("sha256").update(body).digest("hex");
          if (actual !== expected) {
            throw new Error(`did not match the pinned checksum (got ${actual})`);
          }
        }
        archive = body;
        url = candidate;
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${candidate}: ${message}`);
        this.#ctx.logger?.warn?.("synomega: Ketcher source failed, trying the next one (%s)", message);
      }
    }
    if (archive === void 0) {
      throw new Error(`downloading Ketcher ${version} failed from every source:
${failures.join("\n")}`);
    }
    this.#state = { ...this.#state, phase: "extracting", detail: "unpacking the editor" };
    const written = await extractApp(archive, this.root);
    await writeFile3(join2(this.root, STAMP), `${JSON.stringify({ version, url, files: written, at: (/* @__PURE__ */ new Date()).toISOString() }, null, 2)}
`);
    this.#state = { ...this.#state, phase: "ready", detail: "ready" };
  }
  /** Poll for the other provisioner's stamp rather than duplicating its download. */
  async #awaitOtherProvisioner() {
    const deadline = Date.now() + OTHER_PROVISIONER_WAIT_MS2;
    while (Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 2e3));
      if (existsSync2(join2(this.root, STAMP))) return;
    }
    throw new Error("another process has been installing the editor for too long; remove the lock file to retry");
  }
};
async function download(url) {
  if (url.startsWith("file:")) return Buffer.from(await readFile3(fileURLToPath(url)));
  const abort = new AbortController();
  const deadline = setTimeout(() => {
    abort.abort(new Error(`no response within ${CONNECT_TIMEOUT_MS / 1e3}s`));
  }, CONNECT_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { signal: abort.signal });
  } finally {
    clearTimeout(deadline);
  }
  if (!response.ok) throw new Error(`downloading Ketcher failed: ${response.status} ${response.statusText} (${url})`);
  return Buffer.from(await response.arrayBuffer());
}
async function extractApp(archive, root) {
  const entries = readEntries(archive).filter((entry) => !entry.name.endsWith("/"));
  const files = entries.filter((entry) => {
    if (!isSafeEntryName(entry.name)) return false;
    const base = entry.name.slice(entry.name.lastIndexOf("/") + 1);
    if (entry.name.startsWith("__MACOSX/") || base.startsWith("._")) return false;
    return !UNUSED_ENTRIES.some((prefix) => base.startsWith(prefix));
  });
  const strip = commonDirectory(files.map((entry) => entry.name));
  if (!files.some((entry) => entry.name.slice(strip.length) === "index.html")) {
    throw new Error("the Ketcher archive has no index.html where one was expected");
  }
  await rm2(root, { recursive: true, force: true });
  let written = 0;
  for (const entry of files) {
    const relative = entry.name.slice(strip.length);
    const target = join2(root, relative);
    await mkdir3(dirname2(target), { recursive: true });
    await writeFile3(target, await readEntry(archive, entry));
    written += 1;
  }
  return written;
}
function commonDirectory(names) {
  if (names.length === 0) return "";
  const first = names[0];
  const slash = first.indexOf("/");
  if (slash < 0) return "";
  const candidate = first.slice(0, slash + 1);
  return names.every((name2) => name2.startsWith(candidate)) ? candidate : "";
}
function createKetcherHandler(assets) {
  return async (req, res) => {
    let pathname;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      return send(res, 400, "text/plain; charset=utf-8", "bad request");
    }
    if (pathname === KETCHER_STATE_PATH) {
      const state2 = assets.describe();
      if (state2.phase === "idle" || state2.phase === "failed") {
        void assets.ensure().catch(() => {
        });
      }
      return send(res, 200, CONTENT_TYPES[".json"], JSON.stringify(assets.describe()), "no-store");
    }
    if (pathname !== KETCHER_ROUTE && !pathname.startsWith(`${KETCHER_ROUTE}/`)) {
      return send(res, 404, "text/plain; charset=utf-8", "not found");
    }
    const state = assets.describe();
    if (state.phase === "disabled") return send(res, 404, "text/plain; charset=utf-8", "the molecule editor is turned off");
    if (state.phase !== "ready") {
      return send(res, 503, "text/plain; charset=utf-8", `the molecule editor is not installed yet (${state.detail})`, "no-store");
    }
    let relative;
    try {
      relative = decodeURIComponent(pathname.slice(KETCHER_ROUTE.length).replace(/^\/+/, ""));
    } catch {
      return send(res, 400, "text/plain; charset=utf-8", "bad request");
    }
    const file = resolveWithin(assets.root, relative === "" ? "index.html" : relative);
    if (file === null) return send(res, 403, "text/plain; charset=utf-8", "forbidden");
    let info;
    try {
      info = await stat2(file);
    } catch {
      return send(res, 404, "text/plain; charset=utf-8", "not found");
    }
    if (!info.isFile()) return send(res, 404, "text/plain; charset=utf-8", "not found");
    const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`;
    const cache = file.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable";
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": cache });
      res.end();
      return;
    }
    const dot = file.lastIndexOf(".");
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[file.slice(dot).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      "Cache-Control": cache,
      ETag: etag,
      // The editor is framed by the harness's own page and nothing else.
      "Content-Security-Policy": "frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    await new Promise((done) => {
      const stream = createReadStream(file);
      stream.on("error", () => {
        res.destroy();
        done();
      });
      stream.on("close", () => {
        done();
      });
      stream.pipe(res);
    });
  };
}
function serveKetcher(ctx, assets) {
  ctx.inject(["webServer"], (webCtx) => {
    const webServer = webCtx.get("webServer");
    if (webServer === void 0) return;
    const handler = createKetcherHandler(assets);
    webCtx.effect(() => webServer.register({ kind: "prefix", path: KETCHER_ROUTE, handler }));
  });
}
function resolveWithin(root, relative) {
  if (relative.includes("\0")) return null;
  const base = resolve(root);
  const target = resolve(base, normalize(relative));
  return target === base || target.startsWith(base + sep) ? target : null;
}
function send(res, status, type, body, cache) {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": String(Buffer.byteLength(body)),
    ...cache === void 0 ? {} : { "Cache-Control": cache }
  });
  res.end(body);
}

// src/index.ts
var name = "@tom2012/dsh-synomega";
var inject = ["tools", "subprocess"];
function workerDirectory() {
  return join3(dirname3(fileURLToPath2(import.meta.url)), "..", "python");
}
function apply(ctx, config) {
  const stateDir = dshHomePath("plugins", "synomega");
  const bootstrap = new Bootstrap(ctx, config, stateDir, workerDirectory());
  const worker = new SynomegaWorker(ctx, config, () => bootstrap.ensure());
  const deps = { worker, bootstrap, config };
  for (const tool of [
    retroTool(deps),
    forwardTool(deps),
    planTool(deps),
    scoreTool(deps),
    evolveTool(deps)
  ]) {
    ctx.tools.register(tool);
  }
  if (config.systemPrompt) {
    const systemPrompt = ctx.get("systemPrompt");
    if (typeof systemPrompt?.section === "function") {
      ctx.effect(() => systemPrompt.section({
        name: SYNOMEGA_SECTION_NAME,
        order: SYNOMEGA_SECTION_ORDER,
        text: SYNOMEGA_GUIDANCE
      }));
    } else {
      ctx.logger?.info?.("synomega: no usable systemPrompt service; tool guidance was not registered");
    }
  }
  const ketcher = new KetcherAssets(ctx, config, stateDir);
  if (config.ketcher.enabled) {
    serveKetcher(ctx, ketcher);
    ketcher.start();
  }
  ctx.effect(() => () => {
    void worker.dispose();
  });
  bootstrap.start();
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map
