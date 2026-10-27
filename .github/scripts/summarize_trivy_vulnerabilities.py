"""Print bounded vulnerability metadata only, never SARIF secret findings."""

import json
import re
import sys


VULNERABILITY_ID = re.compile(r"(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})")
FIELDS = {
    "Package": ("package", re.compile(r"[A-Za-z0-9@._/+:-]{1,200}")),
    "Installed Version": ("installed", re.compile(r"[A-Za-z0-9.!+_~^<>=,| /-]{1,200}")),
    "Fixed Version": ("fixed", re.compile(r"[A-Za-z0-9.!+_~^<>=,| /-]{1,200}")),
    "Severity": ("severity", re.compile(r"UNKNOWN|LOW|MEDIUM|HIGH|CRITICAL")),
}


def summarize(document):
    summaries = []
    for run in document.get("runs", []):
        rules = run.get("tool", {}).get("driver", {}).get("rules", [])
        for result in run.get("results", []):
            rule_id = result.get("ruleId")
            index = result.get("ruleIndex")
            if rule_id is None and isinstance(index, int) and 0 <= index < len(rules):
                rule_id = rules[index].get("id")
            if not isinstance(rule_id, str) or not VULNERABILITY_ID.fullmatch(rule_id):
                continue
            entry = {"id": rule_id}
            message = result.get("message", {}).get("text", "")
            if isinstance(message, str):
                for line in message.splitlines():
                    label, separator, value = line.partition(": ")
                    if separator and label in FIELDS:
                        key, pattern = FIELDS[label]
                        if pattern.fullmatch(value):
                            entry[key] = value
            summaries.append(entry)
    return summaries


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as source:
        print(json.dumps(summarize(json.load(source)), indent=2))
