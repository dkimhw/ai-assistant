"use client";

import { Action, Actions } from "@/components/ai-elements/actions";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Loader } from "@/components/ai-elements/loader";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputAttachment,
  PromptInputAttachments,
  PromptInputBody,
  PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputToolbar,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
import { Response } from "@/components/ai-elements/response";
import {
  Source,
  Sources,
  SourcesContent,
  SourcesTrigger,
} from "@/components/ai-elements/sources";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { DB } from "@/lib/persistence-layer";
import { useChat } from "@ai-sdk/react";
import { CopyIcon, RefreshCcwIcon } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";

import { Fragment, startTransition, useState } from "react";
import type { MyMessage } from "./api/chat/route";
import { useFocusWhenNoChatIdPresent } from "./use-focus-chat-when-new-chat-button-pressed";

/**
 * What each email tool call is called in the transcript. Written from the user's
 * side of the glass — they are told what the assistant did to their email, not
 * which function it called.
 */
const TOOL_TITLES = {
  "tool-searchEmails": "Searched your email",
  "tool-filterEmails": "Filtered your email",
  "tool-triageEmails": "Reviewed what's waiting on you",
  "tool-getEmails": "Read your email in full",
} as const;

export const Chat = (props: { chat: DB.Chat | null }) => {
  const [backupChatId, setBackupChatId] = useState(crypto.randomUUID());
  const [input, setInput] = useState("");
  const searchParams = useSearchParams();
  const router = useRouter();
  const chatIdFromSearchParams = searchParams.get("chatId");

  const chatIdInUse = chatIdFromSearchParams || backupChatId;
  const { messages, sendMessage, status, regenerate, stop } = useChat<MyMessage>({
    id: chatIdInUse,
    messages: props.chat?.messages || [],
    onData: (message) => {
      if (
        message.type === "data-frontend-action" &&
        message.data === "refresh-sidebar"
      ) {
        router.refresh();
      }
    },
    generateId: () => crypto.randomUUID(),
  });

  const ref = useFocusWhenNoChatIdPresent(chatIdFromSearchParams);

  /** A turn the user can still abandon: waiting on the first token, or mid-stream. */
  const inFlight = status === "submitted" || status === "streaming";

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);

    if (!(hasText || hasAttachments)) {
      return;
    }

    startTransition(() => {
      sendMessage(
        {
          text: message.text || "Sent with attachments",
          files: message.files,
        },
        {
          body: {
            id: chatIdInUse,
          },
        }
      );

      setInput("");

      if (!chatIdFromSearchParams) {
        router.push(`/?chatId=${chatIdInUse}`);
        setBackupChatId(crypto.randomUUID());
      }
    });
  };
  return (
    <div className="relative flex-1 items-center flex flex-col min-h-0 w-full">
      <Conversation className="w-full">
        <ConversationContent className="max-w-4xl mx-auto w-full pb-40">
          {messages.map((message) => (
            <div key={message.id}>
              {message.role === "assistant" &&
                message.parts.filter((part) => part.type === "source-url")
                  .length > 0 && (
                  <Sources>
                    <SourcesTrigger
                      count={
                        message.parts.filter(
                          (part) => part.type === "source-url"
                        ).length
                      }
                    />
                    {message.parts
                      .filter((part) => part.type === "source-url")
                      .map((part, i) => (
                        <SourcesContent key={`${message.id}-${i}`}>
                          <Source
                            key={`${message.id}-${i}`}
                            href={part.url}
                            title={part.url}
                          />
                        </SourcesContent>
                      ))}
                  </Sources>
                )}
              {message.parts.map((part, i) => {
                switch (part.type) {
                  case "text":
                    return (
                      <Fragment key={`${message.id}-${i}`}>
                        <Message from={message.role}>
                          <MessageContent>
                            <Response>{part.text}</Response>
                          </MessageContent>
                        </Message>
                        {/*
                          Both halves matter: the last text part of the last
                          message. This compared a part index against
                          `messages.length`, which is a different array — so the
                          actions appeared next to whichever part happened to sit
                          at that index, and on any message long enough to have
                          one. Retry then re-ran the conversation from a button
                          attached to a message in the middle of it.
                        */}
                        {message.role === "assistant" &&
                          i === message.parts.length - 1 &&
                          message.id === messages.at(-1)?.id && (
                            <Actions className="mt-2">
                              <Action
                                onClick={() => regenerate()}
                                label="Retry"
                              >
                                <RefreshCcwIcon className="size-3" />
                              </Action>
                              <Action
                                onClick={() =>
                                  navigator.clipboard.writeText(part.text)
                                }
                                label="Copy"
                              >
                                <CopyIcon className="size-3" />
                              </Action>
                            </Actions>
                          )}
                      </Fragment>
                    );
                  case "reasoning":
                    return (
                      <Reasoning
                        key={`${message.id}-${i}`}
                        className="w-full"
                        isStreaming={
                          status === "streaming" &&
                          i === message.parts.length - 1 &&
                          message.id === messages.at(-1)?.id
                        }
                      >
                        <ReasoningTrigger />
                        <ReasoningContent>{part.text}</ReasoningContent>
                      </Reasoning>
                    );
                  case "tool-searchEmails":
                  case "tool-filterEmails":
                  case "tool-triageEmails":
                  case "tool-getEmails":
                    // Collapsed by default — the transcript stays readable for
                    // anyone who does not care about the mechanics, and the
                    // header's state badge distinguishes in-flight from done.
                    //
                    // All four email tools render the same way and differ only
                    // in their title: what the user needs from the block is the
                    // arguments the assistant actually used, which is what tells
                    // them whether a wrong answer came from retrieval or from
                    // reasoning.
                    return (
                      <Tool key={`${message.id}-${i}`}>
                        <ToolHeader
                          title={TOOL_TITLES[part.type]}
                          type={part.type}
                          state={part.state}
                        />
                        <ToolContent>
                          <ToolInput input={part.input} />
                          <ToolOutput
                            output={part.output}
                            errorText={part.errorText}
                          />
                        </ToolContent>
                      </Tool>
                    );
                  case "dynamic-tool":
                    // Where a *rejected* tool call lands. The SDK builds this
                    // part, rather than a typed one, when the model's arguments
                    // fail the tool's schema — and `filterEmails` has rules a
                    // JSON Schema cannot express, so this is reachable. Without
                    // a case here the assistant appears to pause and retry for
                    // no visible reason.
                    return (
                      <Tool key={`${message.id}-${i}`}>
                        <ToolHeader
                          title={
                            TOOL_TITLES[
                              `tool-${part.toolName}` as keyof typeof TOOL_TITLES
                            ] ?? part.toolName
                          }
                          type={`tool-${part.toolName}`}
                          state={part.state}
                        />
                        <ToolContent>
                          <ToolInput input={part.input} />
                          <ToolOutput
                            output={"output" in part ? part.output : undefined}
                            errorText={
                              "errorText" in part ? part.errorText : undefined
                            }
                          />
                        </ToolContent>
                      </Tool>
                    );
                  default:
                    return null;
                }
              })}
            </div>
          ))}
          {status === "submitted" && <Loader />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="absolute bottom-0 flex items-center justify-center w-full sm:px-6 px-5">
        <PromptInput
          onSubmit={handleSubmit}
          className="mb-4"
          globalDrop
          multiple
        >
          <PromptInputBody>
            <PromptInputAttachments>
              {(attachment) => <PromptInputAttachment data={attachment} />}
            </PromptInputAttachments>
            <PromptInputTextarea
              onChange={(e) => setInput(e.target.value)}
              value={input}
              ref={ref}
              autoFocus
            />
          </PromptInputBody>
          <PromptInputToolbar>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            {/*
              While a turn is in flight the button already draws itself as a
              stop square, so it has to actually stop: `type="submit"` there
              sends the prompt *again* on top of the turn the user was trying to
              abandon. A turn can be eight tool calls long, which is long enough
              that wanting out of one is a normal thing to want.
            */}
            <PromptInputSubmit
              disabled={!input && !inFlight}
              status={status}
              type={inFlight ? "button" : "submit"}
              onClick={inFlight ? () => stop() : undefined}
              aria-label={inFlight ? "Stop" : "Submit"}
            />
          </PromptInputToolbar>
        </PromptInput>
      </div>
    </div>
  );
};
