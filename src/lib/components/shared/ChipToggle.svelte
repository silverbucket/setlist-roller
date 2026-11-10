<script>
    const { checked = false, onchange, children } = $props();
</script>

<label class="chip-toggle" class:active={checked}>
    <input type="checkbox" {checked} onchange={onchange} />
    {@render children()}
</label>

<style>
    .chip-toggle {
        position: relative;
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        min-height: 38px;
        padding: 0 0.85rem;
        border-radius: var(--radius-full);
        background: var(--surface);
        border: 1px solid var(--line-strong);
        color: var(--ink-2);
        font-size: 0.9rem;
        font-weight: 500;
        cursor: pointer;
        transition: background 140ms ease, border-color 140ms ease, color 140ms ease;
        touch-action: manipulation;
        user-select: none;
        -webkit-tap-highlight-color: transparent;
    }
    .chip-toggle:hover {
        background: var(--surface-2);
    }
    .chip-toggle input {
        position: absolute;
        opacity: 0;
        pointer-events: none;
        width: 0;
        height: 0;
        min-height: 0;
    }
    .chip-toggle:has(input:focus-visible) {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }
    /* Selected: filled with the accent tint and a check, so state never
       depends on colour alone. */
    .chip-toggle.active {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--accent-text);
        font-weight: 600;
    }
    .chip-toggle.active::before {
        content: "";
        width: 0.8rem;
        height: 0.8rem;
        margin-left: -0.15rem;
        background: currentColor;
        -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / contain no-repeat;
        mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / contain no-repeat;
    }
</style>
