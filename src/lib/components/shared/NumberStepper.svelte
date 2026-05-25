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
    <button type="button" class="step-btn" onclick={decrement} disabled={value <= min} aria-label="Decrease">-</button>
    <input type="number" {min} {max} {value} oninput={handleInput} class="step-input" />
    <button type="button" class="step-btn" onclick={increment} disabled={value >= max} aria-label="Increase">+</button>
</div>

<style>
    .stepper {
        display: inline-flex;
        align-items: center;
        border-radius: var(--radius-md, 12px);
        border: 1px solid var(--line);
        background: var(--surface);
        overflow: hidden;
    }
    .step-btn {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2.8rem;
        height: 2.8rem;
        border: none;
        border-radius: 0;
        background: transparent;
        font-size: 1.2rem;
        font-weight: 800;
        color: var(--ink, #182230);
        cursor: pointer;
        touch-action: manipulation;
        min-height: 2.8rem;
        padding: 0;
        box-shadow: none;
    }
    .step-btn:hover { background: var(--hover); }
    .step-btn:active { background: var(--hover-strong); transform: none; box-shadow: none; }
    .step-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .step-input {
        width: 3.2rem;
        text-align: center;
        border: none;
        border-left: 1px solid var(--line);
        border-right: 1px solid var(--line);
        border-radius: 0;
        padding: 0.5rem 0.2rem;
        /* iOS zooms inputs <16px on focus — keep at 16px (not rem) to prevent zoom. See app.css. */
        font-size: 16px;
        font-weight: 800;
        background: transparent;
        min-height: 2.8rem;
        -moz-appearance: textfield;
    }
    .step-input::-webkit-inner-spin-button,
    .step-input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
</style>
