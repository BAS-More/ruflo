import importlib.util
import pathlib
import unittest


PATH = pathlib.Path(__file__).resolve().parents[1] / "summarize_trivy_vulnerabilities.py"
spec = importlib.util.spec_from_file_location("summary", PATH)
summary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(summary)


class TrivySummaryTests(unittest.TestCase):
    def document(self, results, rules=()):
        return {"runs": [{"tool": {"driver": {"rules": list(rules)}}, "results": results}]}

    def test_allowlisted_metadata(self):
        result = {"ruleId": "CVE-2026-12345", "message": {"text": (
            "Package: flask\nInstalled Version: 3.1.3\nFixed Version: 3.1.4\n"
            "Severity: HIGH\nDescription: DO_NOT_PRINT_ARBITRARY_PAYLOAD"
        )}}
        self.assertEqual(summary.summarize(self.document([result])), [{
            "id": "CVE-2026-12345", "package": "flask", "installed": "3.1.3",
            "fixed": "3.1.4", "severity": "HIGH"
        }])

    def test_secret_and_misconfiguration_findings_never_print(self):
        results = [{"ruleId": rule, "message": {"text": "Package: DO_NOT_PRINT_SECRET"}}
                   for rule in ["generic-api-key", "AVD-DS-0002", "CVE-2026-12345\nextra"]]
        self.assertEqual(summary.summarize(self.document(results)), [])

    def test_rule_index_and_ghsa(self):
        result = {"ruleIndex": 0, "message": {"text": "Package: @scope/pkg"}}
        self.assertEqual(summary.summarize(self.document(
            [result], [{"id": "GHSA-abcd-1234-wxyz"}]
        )), [{"id": "GHSA-abcd-1234-wxyz", "package": "@scope/pkg"}])

    def test_reject_unbounded_or_arbitrary_fields(self):
        result = {"ruleId": "CVE-2026-12345", "message": {"text": (
            "Package: <script>payload</script>\nFixed Version: " + "x" * 201 +
            "\nSeverity: DO_NOT_PRINT\nToken: DO_NOT_PRINT_SECRET"
        )}}
        self.assertEqual(summary.summarize(self.document([result])), [{"id": "CVE-2026-12345"}])

    def test_empty_and_invalid_index(self):
        self.assertEqual(summary.summarize({}), [])
        self.assertEqual(summary.summarize(self.document([{"ruleIndex": -1}])), [])


if __name__ == "__main__":
    unittest.main()
