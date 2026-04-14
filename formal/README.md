# Provider Liveness Model

TLA+/PlusCal model of the `PostgresProvider` concurrency, verified by the TLC
model checker.

## What this proves

| Property            | Formula                                                  | Meaning                                                            |
| ------------------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| ShutdownTermination | `stop ~> (lifecycle_done /\ listener_done)`              | `onClose()` always resolves (both loops exit)                      |
| CacheFreshness      | `[](<>(cache = db \/ stop))`                             | Cache catches up to DB (or provider shuts down)                    |
| ReconnectLiveness   | `(~connected /\ ~stop) ~> (connected \/ stop)`           | LISTEN reconnects after loss                                       |
| StaleOnDisconnect   | `(~connected /\ ~stop) ~> (stale \/ stop)`               | Stale event emitted on connection loss                             |
| ChangeAnnounced     | `(change_pending /\ ~stop) ~> (~change_pending \/ stop)` | Every DB change is eventually announced via `ConfigurationChanged` |

## Running

```sh
# Install tla2tools.jar (requires Java):
curl -Lo formal/tla2tools.jar \
  https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar

cd formal/

# Compile PlusCal (only after editing the PlusCal block):
java -cp tla2tools.jar pcal.trans ProviderLiveness.tla

# Model check:
java -cp tla2tools.jar tlc2.TLC ProviderLiveness -workers auto
```

TLC either prints "No error found" or a counterexample trace showing the
violating interleaving.

## Modifying

1. Edit the PlusCal block (between `(* --algorithm` and `end algorithm; *)`)
2. Recompile with `pcal.trans`
3. Re-run TLC

Never edit between `BEGIN TRANSLATION` and `END TRANSLATION` — that's
auto-generated.

New properties go after `END TRANSLATION` in the `.tla` and need a
`PROPERTY Name` line in `.cfg`.

`MaxDbVersion` in `.cfg` bounds the state space. 2-3 is sufficient; the protocol
is correct by induction on the loop structure.

## Learning TLA+

- [learntla.com](https://learntla.com) — interactive tutorial
- [Hillel Wayne's "Practical TLA+"](https://www.hillelwayne.com/post/practical-tla/)
  — code-focused
- [Lamport's video course](https://lamport.azurewebsites.net/video/videos.html)
  — definitive, by the creator
