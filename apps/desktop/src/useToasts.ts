import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  dismissErrors,
  dismissToast,
  initialToasts,
  showToast,
  toastDuration,
  type NotifyInput,
  type ToastState,
} from "./toast.js";

type Action =
  | { type: "show"; input: NotifyInput }
  | { type: "dismiss"; id?: number }
  | { type: "dismissErrors" };

function reduce(state: ToastState, action: Action): ToastState {
  if (action.type === "show") return showToast(state, action.input);
  if (action.type === "dismiss") return dismissToast(state, action.id);
  return dismissErrors(state);
}

export function useToasts() {
  const [state, dispatch] = useReducer(reduce, initialToasts);
  const stateRef = useRef(state);
  stateRef.current = state;
  const toast = state.current;
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => dispatch({ type: "dismiss", id: toast.id }), toastDuration(toast));
    return () => clearTimeout(timer);
  }, [toast]);
  const notify = useCallback((input: NotifyInput) => dispatch({ type: "show", input }), []);
  const dismiss = useCallback((id?: number) => dispatch({ type: "dismiss", id }), []);
  const clearErrors = useCallback(() => dispatch({ type: "dismissErrors" }), []);
  return { toast, state: stateRef, notify, dismiss, clearErrors };
}
