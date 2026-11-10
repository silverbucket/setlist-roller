<script>
    // The in-app logo: a flat die face in the band's die colour with white
    // pips — the same die that sits inside the Roll button, inverted. Reads
    // cleanly at 24–56px where the isometric app icon turns into a blob.
    const { size = 28 } = $props();
</script>

<svg aria-hidden="true" class="die-mark" width={size} height={size} viewBox="0 0 32 32">
    <rect width="32" height="32" rx="8" fill="var(--accent-fill)" />
    <g fill="#fff">
        <circle cx="10" cy="10" r="2.6" />
        <circle cx="22" cy="10" r="2.6" />
        <circle cx="16" cy="16" r="2.6" />
        <circle cx="10" cy="22" r="2.6" />
        <circle cx="22" cy="22" r="2.6" />
    </g>
</svg>

<style>
    .die-mark {
        display: block;
        flex-shrink: 0;
        transform: rotate(-8deg);
    }
</style>
