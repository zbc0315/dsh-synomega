"""SynOmega operations behind one flat, JSON-in/JSON-out surface.

Every function here returns the *canonical value* a dsh tool declares in its
``output.schema`` — no formatting, no human prose. The shapes are taken from
SynOmega's own serializers (``Route.to_dict``, ``MoleculeReport.as_dict``,
``EvolutionResult.to_dict``) rather than re-invented, so a change upstream shows
up as a shape change here instead of silently drifting.

Models are expensive to construct (seconds) and are cached per configuration on
the :class:`Session`; the worker keeps one Session for its whole lifetime.
"""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional, Tuple


class OpError(Exception):
    """A domain or input failure that the model should see verbatim.

    ``kind`` is a stable machine-readable tag (``invalid_smiles``,
    ``bad_argument``, ``not_installed``); ``message`` is what a human reads.
    Infrastructure failures are *not* OpErrors — they propagate and the worker
    reports them as ``internal``.
    """

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind
        self.message = message


def _require_smiles(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise OpError("bad_argument", "%s must be a non-empty SMILES string" % field)
    smiles = value.strip()
    from rdkit import Chem  # noqa: PLC0415 - imported lazily; rdkit load is slow
    from rdkit import RDLogger

    RDLogger.DisableLog("rdApp.*")
    if Chem.MolFromSmiles(smiles) is None:
        raise OpError(
            "invalid_smiles",
            "%r is not a parsable SMILES. Resolve the name to SMILES first "
            "(dot-separate multiple molecules)." % smiles,
        )
    return smiles


def _positive_int(value: Any, field: str, *, default: int, maximum: int) -> int:
    if value is None:
        return default
    if not isinstance(value, int) or isinstance(value, bool):
        raise OpError("bad_argument", "%s must be an integer" % field)
    if value < 1 or value > maximum:
        raise OpError("bad_argument", "%s must be between 1 and %d" % (field, maximum))
    return value


def _unit_float(value: Any, field: str, *, default: float) -> float:
    if value is None:
        return default
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise OpError("bad_argument", "%s must be a number" % field)
    if not 0.0 <= float(value) <= 1.0:
        raise OpError("bad_argument", "%s must be in [0, 1]" % field)
    return float(value)


class Session:
    """Lazily-built, per-configuration SynOmega model cache.

    Nothing is constructed until the first op that needs it, so a worker that
    only ever answers ``status`` never pays the model download or load.
    """

    def __init__(self, defaults: Optional[Dict[str, Any]] = None) -> None:
        self.defaults = defaults or {}
        self._planners: Dict[Tuple, Any] = {}
        self._scorers: Dict[Tuple, Any] = {}
        self._forward: Any = None
        self.started_at = time.time()

    # ------------------------------------------------------------- models

    def _synomega(self):
        try:
            import synomega
        except ImportError as exc:  # pragma: no cover - exercised in bootstrap tests
            raise OpError(
                "not_installed",
                "synomega is not importable in this interpreter (%s). The plugin "
                "bootstrap should have installed it." % exc,
            ) from exc
        return synomega

    def planner(
        self,
        *,
        algorithm: str = "retrostar",
        simplify: bool = False,
        plausibility: bool = False,
        plausibility_threshold: float = 0.4,
    ):
        """A planner for one exact configuration.

        The algorithm is fixed at construction in SynOmega (``plan()`` takes no
        algorithm argument), so a different algorithm means a different cached
        planner rather than a per-call flag.
        """
        if algorithm not in ("retrostar", "mcts", "bfs"):
            raise OpError("bad_argument", "unknown algorithm %r" % algorithm)
        key = (algorithm, simplify, plausibility, plausibility_threshold)
        if key not in self._planners:
            self._planners[key] = self._synomega().load_default_planner(
                algorithm=algorithm,
                simplify=simplify,
                plausibility=plausibility,
                plausibility_threshold=plausibility_threshold,
            )
        return self._planners[key]

    def scorer(self, *, simplify: bool = True, **planner_kwargs):
        key = (simplify, tuple(sorted(planner_kwargs.items())))
        if key not in self._scorers:
            self._scorers[key] = self._synomega().load_default_scorer(
                simplify=simplify, **planner_kwargs
            )
        return self._scorers[key]

    def forward_model(self):
        if self._forward is None:
            from synomega.forward import ForwardTemplateGNN

            self._forward = ForwardTemplateGNN.default()
        return self._forward

    # ---------------------------------------------------------------- ops

    def ping(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"pong": True, "uptime_s": round(time.time() - self.started_at, 3)}

    def status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """What is actually loaded right now — never a guess."""
        try:
            version = self._synomega().__version__
            installed = True
            detail = None
        except OpError as exc:
            version, installed, detail = None, False, exc.message
        return {
            "installed": installed,
            "version": version,
            "detail": detail,
            "planners_loaded": len(self._planners),
            "scorers_loaded": len(self._scorers),
            "forward_loaded": self._forward is not None,
            "uptime_s": round(time.time() - self.started_at, 3),
        }

    def retro(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Single-step retrosynthesis: product -> ranked reactant candidates."""
        product = _require_smiles(params.get("product"), "product")
        top_k = _positive_int(params.get("top_k"), "top_k", default=10, maximum=100)
        planner = self.planner(
            algorithm=params.get("algorithm", "retrostar"),
            simplify=bool(params.get("simplify", False)),
            plausibility=bool(params.get("plausibility", False)),
            plausibility_threshold=_unit_float(
                params.get("plausibility_threshold"), "plausibility_threshold", default=0.4
            ),
        )
        started = time.time()
        predictions = planner.model.predict(product, top_k=top_k)
        return {
            "target": product,
            "elapsed_s": round(time.time() - started, 3),
            "predictions": [
                {
                    "rank": i,
                    "reactants": list(p.reactants),
                    "reaction_smiles": "%s>>%s" % (".".join(p.reactants), product),
                    "score": round(float(p.score), 6),
                    "template_id": p.template_id,
                    "plausibility": (p.meta or {}).get("plausibility"),
                }
                for i, p in enumerate(predictions, 1)
            ],
        }

    def forward(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Single-step forward prediction: reactants -> ranked products."""
        reactants = _require_smiles(params.get("reactants"), "reactants")
        top_k = _positive_int(params.get("top_k"), "top_k", default=5, maximum=50)
        started = time.time()
        predictions = self.forward_model().predict(reactants, top_k=top_k)
        return {
            "reactants": reactants,
            "elapsed_s": round(time.time() - started, 3),
            "products": [
                {
                    "rank": i,
                    "product": p.product,
                    "reaction_smiles": "%s>>%s" % (reactants, p.product),
                    "score": round(float(p.score), 6),
                    "template_id": p.template_id,
                }
                for i, p in enumerate(predictions, 1)
            ],
        }

    def plan(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Multi-step route planning down to purchasable building blocks."""
        target = _require_smiles(params.get("target"), "target")
        max_depth = _positive_int(params.get("max_depth"), "max_depth", default=5, maximum=12)
        max_routes = _positive_int(params.get("max_routes"), "max_routes", default=3, maximum=25)
        planner = self.planner(
            algorithm=params.get("algorithm", "retrostar"),
            simplify=bool(params.get("simplify", False)),
            plausibility=bool(params.get("plausibility", False)),
            plausibility_threshold=_unit_float(
                params.get("plausibility_threshold"), "plausibility_threshold", default=0.4
            ),
        )
        result = planner.plan(
            target,
            max_depth=max_depth,
            time_limit=params.get("time_limit"),
            max_expansions=params.get("max_expansions"),
            exclude_target=bool(params.get("exclude_target", False)),
        )
        routes = result.routes[:max_routes]
        return {
            "target": result.target,
            "algorithm": result.algorithm,
            "solved": bool(result.solved),
            "stats": result.stats.as_dict(),
            "num_routes_found": len(result.routes),
            "routes": [r.to_dict() for r in routes],
        }

    def score(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """SynScore: continuous 0-1 makeability, plus the route it came from."""
        target = _require_smiles(params.get("target"), "target")
        max_steps = _positive_int(params.get("max_steps"), "max_steps", default=5, maximum=12)
        # The simplification-constrained model is SynOmega's recommended scoring
        # configuration; `original: true` reverts to the unconstrained one.
        scorer = self.scorer(simplify=not bool(params.get("original", False)))
        report, search = scorer.score_detailed(
            target,
            max_steps=max_steps,
            time_limit=params.get("time_limit"),
            max_expansions=params.get("max_expansions"),
            exclude_target=bool(params.get("exclude_target", False)),
        )
        out = dict(report.as_dict())
        best = getattr(search, "best_route", None) if search is not None else None
        out["best_route"] = best.to_dict() if best is not None else None
        return out

    def evolve(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Multi-component evolution: grow a forward synthesis network."""
        reactants_arg = params.get("reactants")
        reactants_smiles = _require_smiles(reactants_arg, "reactants")
        reactants = [part for part in reactants_smiles.split(".") if part]
        if len(reactants) < 2:
            raise OpError(
                "bad_argument",
                "evolve needs at least two dot-separated reactants, got %d" % len(reactants),
            )
        max_depth = _positive_int(params.get("max_depth"), "max_depth", default=3, maximum=8)
        top = _positive_int(params.get("top"), "top", default=20, maximum=500)
        threshold = _unit_float(params.get("score_threshold"), "score_threshold", default=0.01)

        from synomega.forward import MultiComponentEvolution

        kwargs: Dict[str, Any] = {
            "max_depth": max_depth,
            "score_threshold": threshold,
            "forward_top_k": _positive_int(
                params.get("forward_top_k"), "forward_top_k", default=5, maximum=25
            ),
        }
        if params.get("frontier_width") is not None:
            kwargs["frontier_width"] = _positive_int(
                params.get("frontier_width"), "frontier_width", default=10, maximum=200
            )
        evolution = MultiComponentEvolution(self.forward_model(), **kwargs)
        result = evolution.evolve(reactants)
        try:
            out = result.to_dict(max_molecules=top)
        finally:
            close = getattr(result, "close", None)
            if callable(close):
                close()
        out["reactants"] = reactants
        return out


OPS = ("ping", "status", "retro", "forward", "plan", "score", "evolve")


def dispatch(session: Session, op: str, params: Dict[str, Any]) -> Dict[str, Any]:
    if op not in OPS:
        raise OpError("bad_argument", "unknown op %r (known: %s)" % (op, ", ".join(OPS)))
    return getattr(session, op)(params or {})
