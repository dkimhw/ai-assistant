"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
} from "@/components/ui/sidebar";
import { TrashIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { deleteChatAction } from "./actions/chats";

type ChatListItem = {
  id: string;
  title: string;
};

export function ChatList({
  chats,
  chatIdFromSearchParams,
}: {
  chats: ChatListItem[];
  chatIdFromSearchParams: string;
}) {
  const [chatPendingDeletion, setChatPendingDeletion] =
    useState<ChatListItem | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const handleDelete = () => {
    if (!chatPendingDeletion) return;

    const wasOpenChat = chatPendingDeletion.id === chatIdFromSearchParams;

    startTransition(async () => {
      await deleteChatAction({ chatId: chatPendingDeletion.id });
      setChatPendingDeletion(null);
      // Deleting the chat you were reading leaves the transcript pointing at
      // nothing, so land on a fresh chat rather than an empty one by that id.
      if (wasOpenChat) {
        router.push("/");
      }
      router.refresh();
    });
  };

  if (chats.length === 0) {
    return (
      <div className="px-2 mt-1 text-xs text-sidebar-foreground/50">
        No chats yet! Start by sending a message.
      </div>
    );
  }

  return (
    <>
      <SidebarMenuSub>
        {chats.map((chat) => (
          <SidebarMenuItem key={chat.id}>
            <SidebarMenuButton
              asChild
              isActive={chatIdFromSearchParams === chat.id}
              className="truncate pr-8"
            >
              <Link href={`/?chatId=${chat.id}`}>{chat.title}</Link>
            </SidebarMenuButton>
            <SidebarMenuAction
              showOnHover
              onClick={() => setChatPendingDeletion(chat)}
            >
              <TrashIcon />
              <span className="sr-only">Delete chat</span>
            </SidebarMenuAction>
          </SidebarMenuItem>
        ))}
      </SidebarMenuSub>

      <Dialog
        open={!!chatPendingDeletion}
        onOpenChange={(open) => {
          if (!open) setChatPendingDeletion(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete chat?</DialogTitle>
            <DialogDescription>
              &ldquo;{chatPendingDeletion?.title}&rdquo; and its messages will be
              deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setChatPendingDeletion(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={isPending}
            >
              <TrashIcon className="size-4" />
              {isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
