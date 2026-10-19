import { useEffect, useRef, useState } from "react";
import type { Board } from "@todocue/client";
import type { PeriodicReminder, RuntimeEvent } from "@todocue/shared";
import { client, subscribe, type ConnectionState } from "./bridge.js";
import { latestBoard } from "./model.js";

export function useRuntime(onEvent?: (event: RuntimeEvent) => void) {
  const [board, setBoard] = useState<Board | null>(null);
  const [rules, setRules] = useState<PeriodicReminder[]>([]);
  const [connection, setConnection] = useState<ConnectionState>({
    online: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const callback = useRef(onEvent);
  callback.current = onEvent;
  const refresh = useRef<() => Promise<string | null>>(async () => "Runtime is not ready");
  useEffect(() => {
    let stopped = false,
      online = false,
      epoch = 0,
      generation: string | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let dispose: (() => void) | undefined;
    let pending: Promise<string | null> | undefined,
      dirty = false;
    refresh.current = () => {
      dirty = true;
      if (pending) return pending;
      pending = (async () => {
        try {
          do {
            dirty = false;
            const requestEpoch = epoch;
            const [snapshot, periodic] = await Promise.all([
              client.board(),
              client.listPeriodicReminders(),
            ]);
            if (!stopped && requestEpoch === epoch) {
              setBoard((current) => latestBoard(current, snapshot));
              setRules(periodic.reminders);
              setError(null);
            }
          } while (dirty && !stopped);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!stopped) setError(message);
          return message;
        } finally {
          pending = undefined;
        }
        return null;
      })();
      return pending;
    };
    void subscribe(
      (event) => {
        if (stopped) return;
        if (event.type === "runtime.started") {
          epoch++;
          setBoard(null);
        }
        setRevision((value) => value + 1);
        callback.current?.(event);
        if (!refreshTimer)
          refreshTimer = setTimeout(() => {
            refreshTimer = undefined;
            void refresh.current();
          }, 150);
      },
      (state) => {
        if (stopped) return;
        if (state.generation && state.generation !== generation) {
          generation = state.generation;
          epoch++;
          setBoard(null);
        }
        online = state.online;
        setConnection(state);
        if (state.online) void refresh.current();
      },
    )
      .then((stop) => {
        if (stopped) stop();
        else dispose = stop;
      })
      .catch((error) => {
        if (!stopped) setError(String(error));
      });
    const timer = setInterval(() => {
      if (online) void refresh.current();
    }, 30000);
    return () => {
      stopped = true;
      epoch++;
      dispose?.();
      clearTimeout(refreshTimer);
      clearInterval(timer);
    };
  }, []);
  return {
    board,
    rules,
    connection,
    revision,
    error,
    // Automatic refreshes report errors through state; explicit reconnection must also reject.
    refresh: async () => { await refresh.current(); },
    reconnect: async () => {
      const error = await refresh.current();
      if (error !== null) throw new Error(error);
    },
  };
}
