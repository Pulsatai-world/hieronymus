Renders a Lucide icon — Akore Labs' standard icon system (1.75px stroke, rounded caps). Intentional addition: no icon set was provided, so the brand adopts Lucide for its clean, tech-forward line style.

```jsx
<Icon name="map-pin" size={22} color="var(--violet-600)" />
```

Requires the Lucide UMD script on the page:
`<script src="https://unpkg.com/lucide@latest"></script>`. Any Lucide icon name works; favor location/AI-flavored glyphs (`map-pin`, `sparkles`, `radar`, `search`, `trending-up`) to match the GEO positioning.
