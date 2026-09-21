import { uid } from "../utils.js";

// Toast tone vocabulary. Values are the CSS class names that style the pill;
// callers go through the typed toastInfo/toastWarn/toastError helpers so a
// typo can't silently fall back to the default style.
const TOAST_TONE = Object.freeze({
    INFO: "info",
    WARN: "warning",
    DANGER: "danger",
});

const VALID_TOAST_TONES = new Set(Object.values(TOAST_TONE));

// Danger gets a longer dwell so more severe messages remain visible longer.
const TOAST_DURATION_MS = { default: 6000, danger: 12000 };

// Per-app navigation, toast queue, and confirmation state.
export function createUiStore() {
    // ---- ui ----
    let activeView = $state("roll");
    let busyMessage = $state("");
    let toastMessages = $state([]);
    let toastDismissTimer = null;

    // ---- toast ----
    /** Start the dwell timer for the first queued non-sticky toast. */
    function scheduleToastDismissal() {
        if (toastDismissTimer !== null) {
            clearTimeout(toastDismissTimer);
            toastDismissTimer = null;
        }
        const activeToast = toastMessages[0];
        if (!activeToast || activeToast.sticky) return;
        const duration =
            activeToast.tone === TOAST_TONE.DANGER ? TOAST_DURATION_MS.danger : TOAST_DURATION_MS.default;
        toastDismissTimer = setTimeout(() => {
            toastDismissTimer = null;
            toastMessages = toastMessages.filter((toast) => toast.id !== activeToast.id);
            scheduleToastDismissal();
        }, duration);
    }

    /** Add a toast to the FIFO display queue without replacing the active message. */
    function addToast(message, tone, options = {}) {
        // Unknown tones fall back to INFO instead of silently rendering as the
        // default style with no semantic class (e.g. "warn" vs "warning").
        const validTone = VALID_TOAST_TONES.has(tone) ? tone : TOAST_TONE.INFO;
        const id = uid("toast");
        // Optional action button (e.g. "Refresh" on the update prompt).
        // Clicking it dismisses the toast, then runs the handler.
        const action =
            options.action && typeof options.action.onClick === "function"
                ? { label: options.action.label || "OK", onClick: options.action.onClick }
                : null;
        const queueWasEmpty = toastMessages.length === 0;
        toastMessages = [...toastMessages, { id, message, tone: validTone, action, sticky: !!options.sticky }];
        if (queueWasEmpty) scheduleToastDismissal();
    }

    /** Remove a toast and start the next queued toast's full dwell period. */
    function dismissToast(id) {
        const wasActive = toastMessages[0]?.id === id;
        toastMessages = toastMessages.filter((t) => t.id !== id);
        if (wasActive) scheduleToastDismissal();
    }

    // ---- destructive confirm ----
    // In-app replacement for window.confirm (#60): native dialogs look
    // foreign in the installed PWA and the chained deleteAllData confirms
    // were easy to misclick through. One request at a time; App.svelte
    // renders the modal and calls resolveConfirm.
    let confirmRequest = $state(null);

    /**
     * Ask the user to confirm a destructive action. Resolves true/false.
     * options: { title, message?, confirmLabel?, cancelLabel?, requireText? }
     * — requireText demands the user type the given string (e.g. the band
     * name) before the confirm button enables.
     */
    function requestConfirm(options) {
        return new Promise((resolve) => {
            // A newer request supersedes a pending one, which resolves as
            // cancelled — never leave a caller hanging.
            if (confirmRequest) confirmRequest.resolve(false);
            confirmRequest = {
                title: "Are you sure?",
                message: "",
                confirmLabel: "Confirm",
                cancelLabel: "Cancel",
                requireText: "",
                ...options,
                resolve,
            };
        });
    }

    function resolveConfirm(result) {
        const request = confirmRequest;
        confirmRequest = null;
        request?.resolve(Boolean(result));
    }

    /**
     * Run a toast's action button and dismiss it. Lives here (not inline in
     * the template) because the template's {@const toast} re-evaluates the
     * moment the dismiss empties toastMessages — an inline
     * `dismiss(); toast.action.onClick()` reads `toast` as undefined and
     * the action never fires. Capture first, then mutate.
     */
    function runToastAction(id) {
        const toast = toastMessages.find((t) => t.id === id);
        const onClick = toast?.action?.onClick;
        dismissToast(id);
        if (typeof onClick === "function") onClick();
    }
    function toastInfo(message)  { addToast(message, TOAST_TONE.INFO); }
    function toastWarn(message)  { addToast(message, TOAST_TONE.WARN); }
    function toastError(message) { addToast(message, TOAST_TONE.DANGER); }
    /**
     * Persistent toast with an action button. Used for the service-worker
     * update prompt: it must not auto-dismiss (the user may be mid-set and
     * needs to choose their moment), so it stays until acted on or
     * explicitly dismissed via the pill's close button.
     */
    function toastAction(message, actionLabel, onAction) {
        addToast(message, TOAST_TONE.INFO, {
            sticky: true,
            action: { label: actionLabel, onClick: onAction },
        });
    }

    // ---- navigation ----
    function syncRouteFromHash() {
        const next = window.location.hash.replace(/^#\/?/, "") || "roll";
        const allowed = ["roll", "saved", "songs", "band", "help"];
        activeView = allowed.includes(next) ? next : "roll";
    }

    function navigate(view) {
        window.location.hash = `/${view}`;
    }

    return {
        toastWarn,
        toastError,
        get busyMessage() { return busyMessage; },
        set busyMessage(value) { busyMessage = value; },
        toastInfo,
        navigate,
        requestConfirm,
        syncRouteFromHash,
        get activeView() { return activeView; },
        get toastMessages() { return toastMessages; },
        toastAction,
        dismissToast,
        runToastAction,
        get confirmRequest() { return confirmRequest; },
        resolveConfirm,
    };
}
