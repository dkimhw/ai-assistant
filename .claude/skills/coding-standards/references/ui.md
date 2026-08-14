# UI and component standards

## Where components go

- Shadcn components → `app/components/ui/`
- Custom components → directly in `app/components/`

Don't nest component folders deeper than that.

## Class names

Use `cn()` from `~/lib/utils` to combine Tailwind classes. It's clsx +
tailwind-merge, so later conflicting classes win.

```tsx
import { cn } from "~/lib/utils";

<div className={cn("px-4 py-2", isActive && "bg-accent", className)} />;
```

## Prices

Price values come out of the db in cents. Render them with `formatPrice()` from
`~/lib/utils` — it handles the "Free" case for `0`/`null`. Don't divide by 100
inline.

```tsx
<span>{formatPrice(course.priceInCents)}</span>
```
