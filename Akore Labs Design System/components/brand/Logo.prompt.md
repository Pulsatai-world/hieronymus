Renders an official Akore Labs logo from the packaged image assets. Never re-draw the mark — always use this.

```jsx
<Logo variant="horizontal" theme="dark" height={40} base="assets" />
```

`variant`: `mark` (the "A" locator), `horizontal` (lockup), `stacked`. `theme`: `dark` (violet/white, for dark backgrounds) or `light` (black, for light backgrounds). Set `base` to the relative path of the folder holding the logo PNGs (copy them from `assets/`).
