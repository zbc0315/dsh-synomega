"""Contract tests for the op layer, run against fakes.

No SynOmega, no rdkit, no model downloads: the point is to pin the JSON shapes
and the error taxonomy the host depends on, so a shape regression fails here in
milliseconds instead of during a live session.
"""

from __future__ import annotations

import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# --------------------------------------------------------------------- fakes

class FakePrediction:
    def __init__(self, reactants, score, template_id=None, meta=None):
        self.reactants = tuple(reactants)
        self.score = score
        self.template_id = template_id
        self.meta = meta or {}


class FakeForwardPrediction:
    def __init__(self, product, score, template_id=None):
        self.product = product
        self.score = score
        self.template_id = template_id
        self.meta = {}


class FakeStats:
    def as_dict(self):
        return {"expansions": 7, "model_calls": 2, "nodes_created": 9,
                "reactions_created": 4, "elapsed_s": 0.5, "terminated_by": "solved"}


class FakeRoute:
    def to_dict(self):
        return {"solved": True, "num_steps": 1, "depth": 1, "bb_coverage": 1.0,
                "cumulative_score": 0.43,
                "tree": {"type": "mol", "smiles": "CC(=O)Nc1ccccc1O",
                         "in_stock": False, "depth": 0,
                         "children": [{"type": "reaction",
                                       "smiles": "CC(=O)O.Nc1ccccc1O>>CC(=O)Nc1ccccc1O",
                                       "score": 0.43, "template_id": 12,
                                       "children": [
                                           {"type": "mol", "smiles": "CC(=O)O",
                                            "in_stock": True, "depth": 1},
                                           {"type": "mol", "smiles": "Nc1ccccc1O",
                                            "in_stock": True, "depth": 1}]}]}}


class FakeSearchResult:
    def __init__(self, target):
        self.target = target
        self.solved = True
        self.algorithm = "retrostar"
        self.stats = FakeStats()
        self.routes = [FakeRoute(), FakeRoute(), FakeRoute(), FakeRoute()]

    @property
    def best_route(self):
        return self.routes[0]


class FakeModel:
    def predict(self, smiles, top_k=50):
        return [FakePrediction(("CC(=O)O", "Nc1ccccc1O"), 0.43, 12,
                               {"plausibility": 0.81}),
                FakePrediction(("CC(=O)Cl", "Nc1ccccc1O"), 0.21, 34)][:top_k]


class FakePlanner:
    def __init__(self, **kwargs):
        self.kwargs = kwargs
        self.model = FakeModel()
        self.calls = []

    def plan(self, target, **kwargs):
        self.calls.append((target, kwargs))
        return FakeSearchResult(target)


class FakeReport:
    def as_dict(self):
        return {"smiles": "CC(=O)Nc1ccccc1O", "solved": True, "score": 1.0,
                "bb_coverage": 1.0, "min_steps": 1, "min_route_depth": 1,
                "num_routes": 4, "num_leaves": 2, "num_purchasable_leaves": 2,
                "max_steps": 5, "elapsed_s": 0.5, "expansions": 7,
                "terminated_by": "solved", "error": None}


class FakeScorer:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def score_detailed(self, smiles, **kwargs):
        return FakeReport(), FakeSearchResult(smiles)


class FakeForwardModel:
    def predict(self, reactants, top_k=10):
        return [FakeForwardPrediction("CC(=O)NCc1ccccc1", 0.64, 5)][:top_k]


class FakeEvolutionResult:
    def __init__(self):
        self.closed = False

    def to_dict(self, max_molecules=1000):
        return {"stats": {"rounds": 2, "num_reactions": 6}, "num_molecules": 5,
                "num_reaction_edges": 4,
                "molecules": [{"smiles": "CC(=O)c1ccccc1", "total_score": 1.0,
                               "depth": 0, "step_score": None, "parents": None,
                               "template_id": None}][:max_molecules]}

    def close(self):
        self.closed = True


class FakeEvolution:
    last = None

    def __init__(self, model, **kwargs):
        self.model = model
        self.kwargs = kwargs
        FakeEvolution.last = self

    def evolve(self, reactants):
        self.reactants = reactants
        self.result = FakeEvolutionResult()
        return self.result


def install_fakes():
    """Put a minimal fake `synomega` and `rdkit` on sys.modules."""
    rdkit = types.ModuleType("rdkit")
    chem = types.ModuleType("rdkit.Chem")
    logger = types.ModuleType("rdkit.RDLogger")
    # Anything containing '?' is our stand-in for unparsable.
    chem.MolFromSmiles = lambda s: None if "?" in s else object()
    logger.DisableLog = lambda pattern: None
    rdkit.Chem = chem
    rdkit.RDLogger = logger
    sys.modules["rdkit"] = rdkit
    sys.modules["rdkit.Chem"] = chem
    sys.modules["rdkit.RDLogger"] = logger

    synomega = types.ModuleType("synomega")
    synomega.__version__ = "0.8.0-fake"
    synomega.load_default_planner = lambda **kw: FakePlanner(**kw)
    synomega.load_default_scorer = lambda **kw: FakeScorer(**kw)
    forward = types.ModuleType("synomega.forward")
    forward.ForwardTemplateGNN = type(
        "ForwardTemplateGNN", (), {"default": staticmethod(lambda: FakeForwardModel())})
    forward.MultiComponentEvolution = FakeEvolution
    synomega.forward = forward
    sys.modules["synomega"] = synomega
    sys.modules["synomega.forward"] = forward


install_fakes()

from ops import OpError, Session, dispatch  # noqa: E402


# --------------------------------------------------------------------- tests

class OpsTest(unittest.TestCase):
    def setUp(self):
        self.session = Session()

    def test_ping_and_status(self):
        self.assertTrue(dispatch(self.session, "ping", {})["pong"])
        status = dispatch(self.session, "status", {})
        self.assertTrue(status["installed"])
        self.assertEqual(status["version"], "0.8.0-fake")
        self.assertFalse(status["forward_loaded"])

    def test_unknown_op_is_a_bad_argument(self):
        with self.assertRaises(OpError) as caught:
            dispatch(self.session, "nope", {})
        self.assertEqual(caught.exception.kind, "bad_argument")

    def test_invalid_smiles_has_its_own_kind(self):
        with self.assertRaises(OpError) as caught:
            dispatch(self.session, "retro", {"product": "C?C"})
        self.assertEqual(caught.exception.kind, "invalid_smiles")

    def test_missing_required_argument(self):
        with self.assertRaises(OpError) as caught:
            dispatch(self.session, "retro", {})
        self.assertEqual(caught.exception.kind, "bad_argument")

    def test_retro_shape(self):
        out = dispatch(self.session, "retro", {"product": "CC(=O)Nc1ccccc1O", "top_k": 2})
        self.assertEqual(out["target"], "CC(=O)Nc1ccccc1O")
        first = out["predictions"][0]
        self.assertEqual(first["rank"], 1)
        self.assertEqual(first["reactants"], ["CC(=O)O", "Nc1ccccc1O"])
        self.assertEqual(first["reaction_smiles"],
                         "CC(=O)O.Nc1ccccc1O>>CC(=O)Nc1ccccc1O")
        self.assertEqual(first["plausibility"], 0.81)
        self.assertIsNone(out["predictions"][1]["plausibility"])

    def test_retro_top_k_bounds(self):
        for bad in (0, -1, 101, "3", True):
            with self.assertRaises(OpError):
                dispatch(self.session, "retro", {"product": "CCO", "top_k": bad})

    def test_forward_shape(self):
        out = dispatch(self.session, "forward", {"reactants": "CC(=O)O.NCc1ccccc1"})
        self.assertEqual(out["products"][0]["product"], "CC(=O)NCc1ccccc1")
        self.assertEqual(out["products"][0]["reaction_smiles"],
                         "CC(=O)O.NCc1ccccc1>>CC(=O)NCc1ccccc1")

    def test_plan_truncates_to_max_routes(self):
        out = dispatch(self.session, "plan",
                       {"target": "CC(=O)Nc1ccccc1O", "max_routes": 2})
        self.assertEqual(len(out["routes"]), 2)
        self.assertEqual(out["num_routes_found"], 4)
        self.assertTrue(out["solved"])
        self.assertEqual(out["stats"]["terminated_by"], "solved")
        self.assertEqual(out["routes"][0]["tree"]["type"], "mol")

    def test_plan_rejects_unknown_algorithm(self):
        with self.assertRaises(OpError):
            dispatch(self.session, "plan", {"target": "CCO", "algorithm": "astar"})

    def test_score_carries_best_route(self):
        out = dispatch(self.session, "score", {"target": "CC(=O)Nc1ccccc1O"})
        self.assertEqual(out["score"], 1.0)
        self.assertIsNotNone(out["best_route"])
        self.assertEqual(out["best_route"]["tree"]["smiles"], "CC(=O)Nc1ccccc1O")

    def test_score_default_uses_simplify_model(self):
        dispatch(self.session, "score", {"target": "CCO"})
        scorer = list(self.session._scorers.values())[0]
        self.assertTrue(scorer.kwargs["simplify"])

    def test_score_original_flag_flips_the_model(self):
        dispatch(self.session, "score", {"target": "CCO", "original": True})
        scorer = list(self.session._scorers.values())[0]
        self.assertFalse(scorer.kwargs["simplify"])

    def test_evolve_needs_two_reactants(self):
        with self.assertRaises(OpError) as caught:
            dispatch(self.session, "evolve", {"reactants": "CC(=O)c1ccccc1"})
        self.assertEqual(caught.exception.kind, "bad_argument")

    def test_evolve_closes_the_result(self):
        out = dispatch(self.session, "evolve",
                       {"reactants": "CC(=O)c1ccccc1.C=O.CNC", "top": 5})
        self.assertEqual(out["reactants"], ["CC(=O)c1ccccc1", "C=O", "CNC"])
        self.assertEqual(out["num_molecules"], 5)
        self.assertTrue(FakeEvolution.last.result.closed)

    def test_planner_cache_is_keyed_by_configuration(self):
        dispatch(self.session, "retro", {"product": "CCO"})
        dispatch(self.session, "retro", {"product": "CCO"})
        self.assertEqual(len(self.session._planners), 1)
        dispatch(self.session, "retro", {"product": "CCO", "simplify": True})
        self.assertEqual(len(self.session._planners), 2)


class WorkerFramingTest(unittest.TestCase):
    def test_handle_wraps_op_errors(self):
        import worker

        session = Session()
        out = worker.handle(session, {"id": "1", "op": "retro", "params": {"product": "C?C"}})
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"]["kind"], "invalid_smiles")
        self.assertEqual(out["id"], "1")

    def test_handle_wraps_unexpected_errors_as_internal(self):
        import worker

        class Boom(Session):
            def ping(self, params):
                raise RuntimeError("boom")

        out = worker.handle(Boom(), {"id": "2", "op": "ping"})
        self.assertFalse(out["ok"])
        self.assertEqual(out["error"]["kind"], "internal")
        self.assertIn("boom", out["error"]["message"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
