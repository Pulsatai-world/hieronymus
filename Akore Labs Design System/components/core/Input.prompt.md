Labeled text field with brand focus ring and hint / error states.

```jsx
<Input label="Work email" placeholder="you@company.com"
       iconLeft={<Icon name="mail" size={18} />} hint="We reply within one business day." />
```

Set `error` to paint the field red and show the message. Supports `iconLeft`, `disabled`, and any native input `type`.
