# Data Path Integrity Verification Patterns

## Problem: Silent Data Loss

A class of bugs where data passes through the hardware but is **not processed/verified**,
and the DUT self-reports PASS. The verification environment trusts the DUT's status and
misses the bug.

### Real-World Example (DDR BIST)

```
FSM leaves READ_WAIT before R data fully consumed
  -> exp_valid drops to 0
  -> data_checker stops comparing
  -> no compare_error generated
  -> DUT reports sts_test_pass = 1
  -> Test checks (done && pass) -> PASS
  -> Bug escapes: 23% of read beats never compared
```

## Core Principle

**Never trust the DUT's self-reported pass/fail. Independently verify data path completeness.**

## Three Mandatory Checks

### Check 1: End-of-Test Comparison Count Assertion

After every test, verify that the actual number of data comparisons matches the expected count.

```python
# Calculate expected comparisons
beats_per_burst = burst_len + 1
bursts_per_iter = addr_range // (beats_per_burst * beat_bytes)
expected_comparisons = bursts_per_iter * beats_per_burst * iterations

# Get actual from monitor
actual_comparisons = data_checker_monitor.total_comparisons

# Assert completeness
assert actual_comparisons == expected_comparisons, (
    f"Data comparison incomplete: {actual_comparisons}/{expected_comparisons} "
    f"({actual_comparisons * 100 // expected_comparisons}%). "
    f"Possible silent data loss in DUT pipeline."
)
```

**When to apply**: Every test that involves data write-then-read verification.

### Check 2: AXI R Channel Beat Completeness

Every AR request must receive exactly (ARLEN+1) R beats, with RLAST on the final beat.

```python
class AXIReadIntegrityChecker:
    """Track AR requests and verify R response completeness."""

    def __init__(self):
        self.pending_reads = {}  # id -> {addr, expected_beats}
        self.errors = []

    def on_ar_handshake(self, addr, arlen, arid):
        self.pending_reads[arid] = {
            "addr": addr,
            "expected": arlen + 1,
            "received": 0,
        }

    def on_r_beat(self, arid, rlast):
        if arid in self.pending_reads:
            self.pending_reads[arid]["received"] += 1
            if rlast:
                entry = self.pending_reads.pop(arid)
                if entry["received"] != entry["expected"]:
                    self.errors.append(
                        f"AR addr=0x{entry['addr']:x}: "
                        f"received {entry['received']} beats, "
                        f"expected {entry['expected']}"
                    )

    def end_of_test_check(self):
        # All AR requests should have been fully responded
        assert len(self.pending_reads) == 0, (
            f"{len(self.pending_reads)} AR requests still pending: "
            f"{[f'0x{v[\"addr\"]:x}' for v in self.pending_reads.values()]}"
        )
        assert len(self.errors) == 0, (
            f"R beat count mismatches:\n" +
            "\n".join(self.errors)
        )
```

**When to apply**: Any design with AXI read channel, especially with multiple outstanding reads.

### Check 3: Input/Output Transaction Counter Reconciliation

Maintain independent counters at data source and sink. At end of test, verify they match.

```python
class TransactionScoreboard:
    """Track data items through the pipeline."""

    def __init__(self):
        self.produced = 0  # Items entered the pipeline
        self.consumed = 0  # Items exited and were checked
        self.dropped = 0   # Items entered but never exited

    def on_write(self):
        self.produced += 1

    def on_read_compare(self):
        self.consumed += 1

    def end_of_test_check(self):
        self.dropped = self.produced - self.consumed
        assert self.dropped == 0, (
            f"Transaction leak: produced={self.produced}, "
            f"consumed={self.consumed}, dropped={self.dropped}"
        )
```

**When to apply**: Any data-in / data-out pipeline where completeness matters.

## Anti-Patterns to Avoid

| Anti-Pattern | Why It's Dangerous | Fix |
|---|---|---|
| `assert done and pass_status` only | DUT can skip verification and still report pass | Add comparison count check |
| Trusting AXI Monitor beat count | Monitor may mistrack with multiple outstanding | Use independent R channel checker |
| No end-of-test scoreboard check | Dropped data goes undetected | Always reconcile counters |
| Checking only first/last transaction | Middle transactions may be corrupted/missing | Count ALL transactions |
| Relying on timeout as failure detector | Silent data loss completes within timeout | Assert on completeness metrics |

## Checklist for New Tests

Before marking a test as complete, verify:

- [ ] Expected comparison count calculated and asserted
- [ ] AXI R beat completeness checked (if applicable)
- [ ] Write count == Read count (if write-then-read pattern)
- [ ] No pending transactions at end of test
- [ ] Test fails when DUT data path is artificially broken (negative test)

## Applicability

This pattern applies to **any design** where:
1. Data flows through a pipeline with internal state machines
2. The DUT has self-check logic that can be bypassed by state machine bugs
3. Multiple outstanding transactions exist (AXI, AHB, PCIe, etc.)
4. The FSM controls enable/valid signals for downstream checkers

Common affected designs:
- Memory BIST (write-then-read-then-compare)
- DMA engines (source-to-destination transfer)
- Cache controllers (fill-then-read)
- Network packet processors (ingress-to-egress)
- Codec pipelines (encode-then-decode-then-compare)
