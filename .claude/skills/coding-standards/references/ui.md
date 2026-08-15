# UI and component standards

## Where components go

- shadcn/Radix primitives → `src/components/ui/`
- AI chat primitives → `src/components/ai-elements/`
- Shared app components → directly in `src/components/` (`top-bar.tsx`, `side-bar.tsx`)
- Route-local components → the route folder, next to the page
  (`src/app/search/search-input.tsx`)

Don't nest deeper than that. Start route-local and promote to `src/components/`
only when a second route needs it. Files are kebab-case; the exported component
is PascalCase.

**Don't hand-edit `src/components/ui/*` or `ai-elements/*`** — they're generated
by the shadcn CLI (`components.json`) and edits are lost on regeneration. Wrap
them instead.

## Server by default, client at the leaves

Pages are async server components that fetch data. Push `"use client"` down to
the smallest component that actually needs interactivity — `SearchInput` is a
client component, the page that renders it is not.

Client components take plain serialisable props. Don't pass an `Email` straight
through when the list only needs five fields; map to a view shape in the page,
as `toListItem` does in `src/app/search/page.tsx`.

## Class names

Use `cn()` from `@/lib/utils` to combine Tailwind classes. It's clsx +
tailwind-merge, so later conflicting classes win.

```tsx
import { cn } from "@/lib/utils";

<div className={cn("px-4 py-2", isActive && "bg-accent", className)} />;
```

Any component with a styleable root accepts an optional `className` and merges
it last, so callers can override.

## Styling

Tailwind 4, configured in `src/app/globals.css`. Use the semantic theme tokens —
`bg-background`, `text-muted-foreground`, `border-border` — never raw palette
colours like `text-gray-500`. The app supports dark mode via `next-themes`, and
raw colours break it.

Variants come from `class-variance-authority`, following `ui/button.tsx`.

## Props

Destructure props inline with an inline type. Components are the exception to the
object-parameter rule in [typescript.md](typescript.md) — props are already an
object:

```tsx
export function SearchInput({
  initialQuery,
  currentPerPage,
}: {
  initialQuery: string;
  currentPerPage: number;
}) {
```

Icons come from `lucide-react`.

## URL state over component state

Search, pagination, and per-page live in the query string, not React state.
Client components build a `URLSearchParams` and `router.push()`; the page reads
`searchParams`. Omit defaults from the URL to keep it clean. Local `useState` is
for the uncommitted value of an input, not for the applied filter.
