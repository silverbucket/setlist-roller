// OAuth popup relay for iOS standalone PWA login. Loaded as an external
// script (not inline) so auth-relay.html can carry a strict CSP with
// script-src 'self' and no inline allowances or hashes.
(() => {
    const params = {};
    const query = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

    for (const [key, value] of query.entries()) {
        params[key] = value;
    }
    for (const [key, value] of hashParams.entries()) {
        params[key] = value;
    }

    const message = document.getElementById("message");
    if (!window.opener) {
        message.textContent =
            "Login finished in Safari, but this page cannot hand the result back to the installed app. Return to the home-screen app and retry there, or keep using Safari for login.";
        return;
    }

    window.opener.postMessage(
        {
            type: "setlist-roller-auth-result",
            attemptId: params.attempt || "",
            params,
        },
        window.location.origin,
    );

    message.textContent = "Login finished. This window can be closed.";
    window.setTimeout(() => window.close(), 300);
})();
