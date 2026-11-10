<script>
    const { value = 0, min = 0, max = 999, label = "", onchange } = $props();

    function decrement() {
        if (value > min) onchange(value - 1);
    }
    function increment() {
        if (value < max) onchange(value + 1);
    }
    function handleInput(e) {
        const n = Number(e.currentTarget.value);
        if (!Number.isNaN(n)) onchange(Math.max(min, Math.min(max, n)));
    }
</script>

<div class="stepper" role="group" aria-label={label}>
    <button type="button" class="step-btn" onclick={decrement} disabled={value <= min} aria-label="Decrease"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M5 12h14"/></svg></button>
    <input type="number" {min} {max} {value} oninput={handleInput} class="step-input" />
    <button type="button" class="step-btn" onclick={increment} disabled={value >= max} aria-label="Increase"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></button>
</div>

<style>
    .stepper {
        display: inline-flex;
        align-items: stretch;
        height: var(--stepper-h, var(--control-h));
        border-radius: var(--radius-md);
        border: 1px solid var(--line-strong);
        background: var(--surface);
        overflow: hidden;
    }
    .stepper:focus-within {
        border-color: var(--accent);
        box-shadow: var(--focus-ring);
    }
    .step-btn {
        display: grid;
        place-items: center;
        width: 44px;
        border: none;
        border-radius: 0;
        background: transparent;
        color: var(--ink-2);
        cursor: pointer;
        touch-action: manipulation;
        padding: 0;
        -webkit-tap-highlight-color: transparent;
    }
    @media (hover: hover) {
    .step-btn:hover { background: var(--hover); color: var(--ink); }
    }
    .step-btn:active { background: var(--hover-strong); }
    .step-btn:disabled { opacity: 0.3; cursor: not-allowed; background: transparent; }
    .step-btn:focus-visible { outline-offset: -2px; }
    .step-input {
        width: 2.6rem;
        text-align: center;
        border: none;
        border-radius: 0;
        padding: 0;
        /* iOS zooms inputs <16px on focus — keep at 16px (not rem) to prevent zoom. See app.css. */
        font-size: 17px;
        font-family: var(--font-display);
        font-weight: 700;
        font-variant-numeric: tabular-nums;
        color: var(--ink);
        background: transparent;
        -moz-appearance: textfield;
    }
    .step-input:focus,
    .step-input:focus-visible { outline: none; box-shadow: none; }
    .step-input::-webkit-inner-spin-button,
    .step-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
</style>
