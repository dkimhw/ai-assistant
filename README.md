# Personal Assistant

## Getting Started

### Prerequisites

- Node.js (v20 or higher)
- pnpm package manager
- API keys for AI providers (Google/Anthropic/OpenAI)
- Completed AI SDK v5 Crash Course (workshop pre-requisite)

### Installation

1. Install dependencies:

```bash
pnpm install
```

2. Set up environment variables (`.env.local`):

```bash
OPENAI_API_KEY=your_key_here      # optional
```

3. Run dev server:

```bash
pnpm run dev
```

4. Open [http://localhost:3000](http://localhost:3000)

## Project Structure

Starting scaffold includes:

- `/src/app/api/chat/route.ts` - Basic chat endpoint (you'll add agent + tools here)
- `/src/components/ai-elements/` - Chat UI components (message, response, reasoning, etc.)
- `/src/lib/persistence-layer.ts` - Chat history + memory persistence
- `/data/emails.json` - 547 emails for retrieval exercises
- `/data/db.local.json` - Local storage for chats + memories

## Tech Stack

- **Framework**: Next.js 15 (App Router + Turbopack)
- **AI SDK**: Vercel AI SDK v5 (provider-agnostic)
- **Models**: Google Gemini 2.5 Flash (default), Claude, GPT-4
- **UI**: Radix UI + Tailwind CSS 4
- **TypeScript**: Full type safety

## Available Scripts

- `pnpm run dev` - Start dev server (Turbopack)
- `pnpm run build` - Build for production
- `pnpm start` - Start production server
