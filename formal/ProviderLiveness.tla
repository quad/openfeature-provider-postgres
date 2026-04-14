--------------------------- MODULE ProviderLiveness ---------------------------
\* Liveness model for PostgresProvider (src/provider.ts).
\* See README.md for usage and background.

EXTENDS Naturals, FiniteSets, Sequences, TLC

CONSTANTS
    MaxDbVersion    \* Upper bound on DB flag versions (keeps state finite).
                    \* Set to 3: means the DB can change flags 3 times.

\* Why MaxDbVersion?
\* TLC must explore a finite state space. In reality, flags can change
\* infinitely many times, but if the protocol is correct for N changes
\* it is correct for N+1 (by induction on the loop structure). Setting
\* this to 2-3 is enough to catch real bugs.

(* --algorithm ProviderLiveness

\* ================================================================
\* GLOBAL VARIABLES
\*
\* These model the shared state that the TypeScript processes read
\* and write. Each one maps to something concrete in provider.ts.
\* ================================================================
variables
    \* --- Database state (external) ---
    db_version = 1,             \* Current flag version in Postgres.
                                \* Bumped by the environment when flags change.

    \* --- Provider cache ---
    cache_version = 1,          \* Version the provider last loaded (loadFlags).
                                \* Starts at 1: initialize() calls loadFlags().

    \* --- syncSignal (models createEvent<"notify"|"sync">) ---
    \* In the TS code, this is an event that can be set("notify"),
    \* set("sync"), waited on, and reset. We model it as two variables:
    sync_signaled = FALSE,      \* Has the event been fired?
    sync_value = "none",        \* What value? "notify", "sync", or "none"

    \* --- Stop signal (models AbortController) ---
    stop_requested = FALSE,     \* Has onClose() been called?
    lifecycle_done = FALSE,     \* Has the lifecycle loop exited?

    \* --- LISTEN connection ---
    listener_connected = TRUE,  \* Is the LISTEN connection alive?
                                \* Starts TRUE: startNotifyListener awaits
                                \* the first session before returning.
    listener_done = FALSE,      \* Has the listener loop exited?

    \* --- Events emitted (for checking properties) ---
    stale_emitted = FALSE,      \* Was ProviderEvents.Stale emitted?
    \* change_pending = TRUE means "the DB has changed since the last
    \* ProviderEvents.ConfigurationChanged emission". Set by the
    \* environment when it bumps db_version; cleared by a refresh that
    \* observes cache_version # db_version (which is exactly the
    \* condition under which refreshCache() emits the event).
    change_pending = FALSE;

\* ================================================================
\* PROCESSES
\*
\* PlusCal process blocks run concurrently. TLC explores every
\* possible interleaving of their labeled steps.
\* ================================================================

\* ================================================================
\* LIFECYCLE: models the while(true) loop, provider.ts lifecycle()
\*
\* The real code does abortable(Promise.race([timer, syncSignal]), signal)
\* with .catch(() => "stop"). We model this as nondeterministic choice:
\* at each iteration, the lifecycle can observe a periodic timeout,
\* a sync signal, or a stop. TLC explores ALL choices.
\* ================================================================
fair process Lifecycle = "lifecycle"
\* "fair process" means TLC assumes WEAK FAIRNESS: if this process
\* is continuously enabled (not blocked), it eventually takes a step.
\* Without this, TLC would accept "the lifecycle never runs" as valid,
\* making all liveness properties vacuously true.
begin
LifecycleLoop:
    while ~stop_requested do

        \* MODEL: abortable(Promise.race([timer, syncSignal.wait()]), signal)
        \*        .catch(() => "stop")
        \*
        \* "either ... or ..." is PlusCal nondeterministic choice.
        \* TLC will explore every branch at every loop iteration.
        either
            \* Branch 1: Periodic timer fires (reason === "sync")
            \* Models: sleep(periodicSyncMs).then(() => "sync")

            PeriodicSync:
                \* refreshCache: loadFlags returns "changed" iff
                \* cache_version # db_version, which causes
                \* ProviderEvents.ConfigurationChanged to fire.
                \* Order matters: read cache_version BEFORE reassigning it.
                if cache_version # db_version then
                    change_pending := FALSE;
                end if;
                cache_version := db_version;

        or
            \* Branch 2: syncSignal fires with "notify"
            \* Models: this.syncSignal.wait() returning "notify"
            await sync_signaled /\ sync_value = "notify";

            NotifySync:
                \* syncSignal.reset()
                sync_signaled := FALSE ||
                sync_value := "none";

            NotifyRefresh:
                \* refreshCache after jitter delay; same change-detection
                \* and event-firing semantics as PeriodicSync.
                if cache_version # db_version then
                    change_pending := FALSE;
                end if;
                cache_version := db_version;

        or
            \* Branch 3: syncSignal fires with "sync" (from reconnect)
            \* Models: this.syncSignal.wait() returning "sync"
            await sync_signaled /\ sync_value = "sync";

            ReconnectSync:
                sync_signaled := FALSE ||
                sync_value := "none";

            ReconnectRefresh:
                \* refreshCache after reconnect; same change-detection
                \* and event-firing semantics as the other refresh paths.
                if cache_version # db_version then
                    change_pending := FALSE;
                end if;
                cache_version := db_version;

        or
            \* Branch 4: abortable rejects (reason === "stop")
            \* Models: .catch(() => "stop") followed by break
            await stop_requested;

        end either;

    end while;

LifecycleDone:
    lifecycle_done := TRUE;

end process;

\* ================================================================
\* LISTENER: models startNotifyListener(), provider.ts
\*
\* Maintains a LISTEN connection. On connection loss, reconnects
\* with retry(). On notification, fires syncSignal("notify").
\* On reconnect, fires syncSignal("sync").
\* The listener receives the AbortSignal directly — stop_requested
\* models signal.aborted.
\* ================================================================
fair process Listener = "listener"
begin
ListenerLoop:
    while ~stop_requested do
        \* Wait for something to happen: either we lose the connection
        \* or we are told to stop.
        either
            \* Connection lost (models: error/end events on the PG client)
            await ~listener_connected;

            EmitStale:
                \* onConnectionLost callback fires ProviderEvents.Stale
                stale_emitted := TRUE;

            Reconnect:
                \* retry() loop: either reconnect succeeds, or the
                \* AbortSignal fires and retry() throws (caught by
                \* catch{}, then break).
                either
                    listener_connected := TRUE;
                or
                    await stop_requested;
                    goto ListenerDone;
                end either;

            SignalSync:
                \* onReconnect() fires syncSignal.set("sync")
                sync_signaled := TRUE ||
                sync_value := "sync";

        or
            \* The listener also races against the abort signal.
            \* Models: abortable(lost.wait(), signal).catch(() => {})
            \* followed by signal.aborted check.
            await stop_requested;

        end either;
    end while;

ListenerDone:
    listener_done := TRUE;

end process;

\* ================================================================
\* ENVIRONMENT: models the outside world
\*
\* This process nondeterministically performs actions that the real
\* world can do at any time: change DB flags, send NOTIFY, kill the
\* connection, or request shutdown.
\*
\* It is NOT declared "fair": the environment has no obligation to
\* do anything. A flag change might never happen. A NOTIFY might
\* never come. This is realistic: we cannot force the outside world
\* to cooperate.
\* ================================================================
process Environment = "env"
begin
EnvLoop:
    while ~lifecycle_done do
        either
            \* --- DB flag change ---
            \* Someone UPDATEs a flag row. We bump the version and
            \* mark a pending announcement (cleared by the next refresh
            \* that observes the stale cache).
            if db_version < MaxDbVersion then
                db_version := db_version + 1 ||
                change_pending := TRUE;
            end if;

        or
            \* --- PG NOTIFY ---
            \* A trigger fires NOTIFY after the flag change.
            \* In the TS code, c.on("notification", onNotification)
            \* calls syncSignal.set("notify").
            if listener_connected then
                sync_signaled := TRUE ||
                sync_value := "notify";
            end if;

        or
            \* --- Connection kill ---
            \* Network blip, PG restart, etc.
            listener_connected := FALSE;

        or
            \* --- Shutdown requested ---
            \* Someone calls provider.onClose().
            stop_requested := TRUE;

        or
            \* --- Nothing happens ---
            \* The environment can also just do nothing.
            skip;

        end either;
    end while;

end process;

end algorithm; *)

\* BEGIN TRANSLATION - theass://of PlusCal will be inserted here
VARIABLES pc, db_version, cache_version, sync_signaled, sync_value, 
          stop_requested, lifecycle_done, listener_connected, listener_done, 
          stale_emitted, change_pending

vars == << pc, db_version, cache_version, sync_signaled, sync_value, 
           stop_requested, lifecycle_done, listener_connected, listener_done, 
           stale_emitted, change_pending >>

ProcSet == {"lifecycle"} \cup {"listener"} \cup {"env"}

Init == (* Global variables *)
        /\ db_version = 1
        /\ cache_version = 1
        /\ sync_signaled = FALSE
        /\ sync_value = "none"
        /\ stop_requested = FALSE
        /\ lifecycle_done = FALSE
        /\ listener_connected = TRUE
        /\ listener_done = FALSE
        /\ stale_emitted = FALSE
        /\ change_pending = FALSE
        /\ pc = [self \in ProcSet |-> CASE self = "lifecycle" -> "LifecycleLoop"
                                        [] self = "listener" -> "ListenerLoop"
                                        [] self = "env" -> "EnvLoop"]

LifecycleLoop == /\ pc["lifecycle"] = "LifecycleLoop"
                 /\ IF ~stop_requested
                       THEN /\ \/ /\ pc' = [pc EXCEPT !["lifecycle"] = "PeriodicSync"]
                               \/ /\ sync_signaled /\ sync_value = "notify"
                                  /\ pc' = [pc EXCEPT !["lifecycle"] = "NotifySync"]
                               \/ /\ sync_signaled /\ sync_value = "sync"
                                  /\ pc' = [pc EXCEPT !["lifecycle"] = "ReconnectSync"]
                               \/ /\ stop_requested
                                  /\ pc' = [pc EXCEPT !["lifecycle"] = "LifecycleLoop"]
                       ELSE /\ pc' = [pc EXCEPT !["lifecycle"] = "LifecycleDone"]
                 /\ UNCHANGED << db_version, cache_version, sync_signaled, 
                                 sync_value, stop_requested, lifecycle_done, 
                                 listener_connected, listener_done, 
                                 stale_emitted, change_pending >>

PeriodicSync == /\ pc["lifecycle"] = "PeriodicSync"
                /\ IF cache_version # db_version
                      THEN /\ change_pending' = FALSE
                      ELSE /\ TRUE
                           /\ UNCHANGED change_pending
                /\ cache_version' = db_version
                /\ pc' = [pc EXCEPT !["lifecycle"] = "LifecycleLoop"]
                /\ UNCHANGED << db_version, sync_signaled, sync_value, 
                                stop_requested, lifecycle_done, 
                                listener_connected, listener_done, 
                                stale_emitted >>

NotifySync == /\ pc["lifecycle"] = "NotifySync"
              /\ /\ sync_signaled' = FALSE
                 /\ sync_value' = "none"
              /\ pc' = [pc EXCEPT !["lifecycle"] = "NotifyRefresh"]
              /\ UNCHANGED << db_version, cache_version, stop_requested, 
                              lifecycle_done, listener_connected, 
                              listener_done, stale_emitted, change_pending >>

NotifyRefresh == /\ pc["lifecycle"] = "NotifyRefresh"
                 /\ IF cache_version # db_version
                       THEN /\ change_pending' = FALSE
                       ELSE /\ TRUE
                            /\ UNCHANGED change_pending
                 /\ cache_version' = db_version
                 /\ pc' = [pc EXCEPT !["lifecycle"] = "LifecycleLoop"]
                 /\ UNCHANGED << db_version, sync_signaled, sync_value, 
                                 stop_requested, lifecycle_done, 
                                 listener_connected, listener_done, 
                                 stale_emitted >>

ReconnectSync == /\ pc["lifecycle"] = "ReconnectSync"
                 /\ /\ sync_signaled' = FALSE
                    /\ sync_value' = "none"
                 /\ pc' = [pc EXCEPT !["lifecycle"] = "ReconnectRefresh"]
                 /\ UNCHANGED << db_version, cache_version, stop_requested, 
                                 lifecycle_done, listener_connected, 
                                 listener_done, stale_emitted, change_pending >>

ReconnectRefresh == /\ pc["lifecycle"] = "ReconnectRefresh"
                    /\ IF cache_version # db_version
                          THEN /\ change_pending' = FALSE
                          ELSE /\ TRUE
                               /\ UNCHANGED change_pending
                    /\ cache_version' = db_version
                    /\ pc' = [pc EXCEPT !["lifecycle"] = "LifecycleLoop"]
                    /\ UNCHANGED << db_version, sync_signaled, sync_value, 
                                    stop_requested, lifecycle_done, 
                                    listener_connected, listener_done, 
                                    stale_emitted >>

LifecycleDone == /\ pc["lifecycle"] = "LifecycleDone"
                 /\ lifecycle_done' = TRUE
                 /\ pc' = [pc EXCEPT !["lifecycle"] = "Done"]
                 /\ UNCHANGED << db_version, cache_version, sync_signaled, 
                                 sync_value, stop_requested, 
                                 listener_connected, listener_done, 
                                 stale_emitted, change_pending >>

Lifecycle == LifecycleLoop \/ PeriodicSync \/ NotifySync \/ NotifyRefresh
                \/ ReconnectSync \/ ReconnectRefresh \/ LifecycleDone

ListenerLoop == /\ pc["listener"] = "ListenerLoop"
                /\ IF ~stop_requested
                      THEN /\ \/ /\ ~listener_connected
                                 /\ pc' = [pc EXCEPT !["listener"] = "EmitStale"]
                              \/ /\ stop_requested
                                 /\ pc' = [pc EXCEPT !["listener"] = "ListenerLoop"]
                      ELSE /\ pc' = [pc EXCEPT !["listener"] = "ListenerDone"]
                /\ UNCHANGED << db_version, cache_version, sync_signaled, 
                                sync_value, stop_requested, lifecycle_done, 
                                listener_connected, listener_done, 
                                stale_emitted, change_pending >>

EmitStale == /\ pc["listener"] = "EmitStale"
             /\ stale_emitted' = TRUE
             /\ pc' = [pc EXCEPT !["listener"] = "Reconnect"]
             /\ UNCHANGED << db_version, cache_version, sync_signaled, 
                             sync_value, stop_requested, lifecycle_done, 
                             listener_connected, listener_done, change_pending >>

Reconnect == /\ pc["listener"] = "Reconnect"
             /\ \/ /\ listener_connected' = TRUE
                   /\ pc' = [pc EXCEPT !["listener"] = "SignalSync"]
                \/ /\ stop_requested
                   /\ pc' = [pc EXCEPT !["listener"] = "ListenerDone"]
                   /\ UNCHANGED listener_connected
             /\ UNCHANGED << db_version, cache_version, sync_signaled, 
                             sync_value, stop_requested, lifecycle_done, 
                             listener_done, stale_emitted, change_pending >>

SignalSync == /\ pc["listener"] = "SignalSync"
              /\ /\ sync_signaled' = TRUE
                 /\ sync_value' = "sync"
              /\ pc' = [pc EXCEPT !["listener"] = "ListenerLoop"]
              /\ UNCHANGED << db_version, cache_version, stop_requested, 
                              lifecycle_done, listener_connected, 
                              listener_done, stale_emitted, change_pending >>

ListenerDone == /\ pc["listener"] = "ListenerDone"
                /\ listener_done' = TRUE
                /\ pc' = [pc EXCEPT !["listener"] = "Done"]
                /\ UNCHANGED << db_version, cache_version, sync_signaled, 
                                sync_value, stop_requested, lifecycle_done, 
                                listener_connected, stale_emitted, 
                                change_pending >>

Listener == ListenerLoop \/ EmitStale \/ Reconnect \/ SignalSync
               \/ ListenerDone

EnvLoop == /\ pc["env"] = "EnvLoop"
           /\ IF ~lifecycle_done
                 THEN /\ \/ /\ IF db_version < MaxDbVersion
                                  THEN /\ /\ change_pending' = TRUE
                                          /\ db_version' = db_version + 1
                                  ELSE /\ TRUE
                                       /\ UNCHANGED << db_version, 
                                                       change_pending >>
                            /\ UNCHANGED <<sync_signaled, sync_value, stop_requested, listener_connected>>
                         \/ /\ IF listener_connected
                                  THEN /\ /\ sync_signaled' = TRUE
                                          /\ sync_value' = "notify"
                                  ELSE /\ TRUE
                                       /\ UNCHANGED << sync_signaled, 
                                                       sync_value >>
                            /\ UNCHANGED <<db_version, stop_requested, listener_connected, change_pending>>
                         \/ /\ listener_connected' = FALSE
                            /\ UNCHANGED <<db_version, sync_signaled, sync_value, stop_requested, change_pending>>
                         \/ /\ stop_requested' = TRUE
                            /\ UNCHANGED <<db_version, sync_signaled, sync_value, listener_connected, change_pending>>
                         \/ /\ TRUE
                            /\ UNCHANGED <<db_version, sync_signaled, sync_value, stop_requested, listener_connected, change_pending>>
                      /\ pc' = [pc EXCEPT !["env"] = "EnvLoop"]
                 ELSE /\ pc' = [pc EXCEPT !["env"] = "Done"]
                      /\ UNCHANGED << db_version, sync_signaled, sync_value, 
                                      stop_requested, listener_connected, 
                                      change_pending >>
           /\ UNCHANGED << cache_version, lifecycle_done, listener_done, 
                           stale_emitted >>

Environment == EnvLoop

(* Allow infinite stuttering to prevent deadlock on termination. *)
Terminating == /\ \A self \in ProcSet: pc[self] = "Done"
               /\ UNCHANGED vars

Next == Lifecycle \/ Listener \/ Environment
           \/ Terminating

Spec == /\ Init /\ [][Next]_vars
        /\ WF_vars(Lifecycle)
        /\ WF_vars(Listener)

Termination == <>(\A self \in ProcSet: pc[self] = "Done")

\* END TRANSLATION

\* Liveness properties (see README.md for explanations)

ShutdownTermination == stop_requested ~> (lifecycle_done /\ listener_done)

CacheFreshness == [](<>(cache_version = db_version \/ stop_requested))

ReconnectLiveness ==
    (~listener_connected /\ ~stop_requested) ~> (listener_connected \/ stop_requested)

StaleOnDisconnect ==
    (~listener_connected /\ ~stop_requested) ~> (stale_emitted \/ stop_requested)

\* Every DB change is eventually announced as ConfigurationChanged
\* (unless the provider shuts down first).
ChangeAnnounced ==
    (change_pending /\ ~stop_requested) ~> (~change_pending \/ stop_requested)

=============================================================================
