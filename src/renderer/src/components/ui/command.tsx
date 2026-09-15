"use client";

import type * as React from "react"
import { SearchIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompleteSeparator,
} from "@/components/ui/autocomplete";

function Command({
  autoHighlight = "always",
  keepHighlight = true,
  mode = "none",
  ...props
}: React.ComponentProps<typeof Autocomplete>) {
  return (
    <Autocomplete
      autoHighlight={autoHighlight}
      inline
      keepHighlight={keepHighlight}
      mode={mode}
      open
      {...props}
    />
  )
}

function CommandDialog({
  title = "Command Palette",
  description = "Search for a command to run...",
  children,
  className,
  showCloseButton = false,
  ...props
}: Omit<React.ComponentProps<typeof Dialog>, "children"> & {
  title?: string
  description?: string
  className?: string
  showCloseButton?: boolean
  children: React.ReactNode
}) {
  return (
    <Dialog {...props}>
      <DialogHeader className="sr-only">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogContent
        className={cn(
          "overflow-hidden rounded-xl! p-0",
          className
        )}
        showCloseButton={showCloseButton}
      >
        {children}
      </DialogContent>
    </Dialog>
  )
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteInput>) {
  return (
    <div data-slot="command-input-wrapper" className="p-1 pb-0">
      <AutocompleteInput
        autoFocus
        data-slot="command-input"
        startAddon={<SearchIcon className="size-4 shrink-0 opacity-50" />}
        className={cn(
          "h-8! rounded-lg! border-transparent bg-transparent shadow-none! dark:bg-transparent",
          className,
        )}
        {...props}
      />
    </div>
  )
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteList>) {
  return (
    <AutocompleteList
      className={className}
      data-slot="command-list"
      {...props}
    />
  );
}

function CommandPanel({
  className,
  ...props 
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden bg-transparent [touch-action:pan-y]",
        className,
      )}
      {...props}
    />
  )
}

function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroup>) {
  return <AutocompleteGroup className={className} data-slot="command-group" {...props} />;
}

function CommandGroupLabel({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteGroupLabel>) {
  return (
    <AutocompleteGroupLabel className={className} data-slot="command-group-label" {...props} />
  )
}

function CommandCollection({ ...props }: React.ComponentProps<typeof AutocompleteCollection>) {
  return <AutocompleteCollection data-slot="command-collection" {...props} />;
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof AutocompleteSeparator>) {
  return (
    <AutocompleteSeparator
      className={className}
      data-slot="command-separator"
      {...props}
    />
  )
}

function CommandItem({ className, ...props }: React.ComponentProps<typeof AutocompleteItem>) {
  return (
    <AutocompleteItem
      className={cn(
        "group/command-item relative data-highlighted:bg-muted data-highlighted:text-foreground data-selected:bg-muted data-selected:bevel data-selected:text-foreground in-data-[slot=dialog-content]:rounded-lg! [&_svg]:pointer-events-none data-highlighted:**:[svg]:text-foreground data-selected:**:[svg]:text-foreground",
        className,
      )}
      data-slot="command-item"
      {...props}
    />
  );
}
function CommandShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto group-data-highlighted/command-item:[&_[data-slot=kbd]]:bg-foreground/[0.08] group-data-highlighted/command-item:[&_[data-slot=kbd]]:text-foreground group-data-selected/command-item:[&_[data-slot=kbd]]:bg-foreground/[0.08] group-data-selected/command-item:[&_[data-slot=kbd]]:text-foreground",
        className,
      )}
      {...props}
    />
  )
}

function CommandFooter({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 border-t border-border-quiet bg-foreground/[0.025] px-4 py-2.5 text-sm font-medium text-muted-foreground [&_[data-slot=kbd]]:bg-foreground/[0.08] [&_[data-slot=kbd]]:text-foreground",
        className,
      )}
      data-slot="command-footer"
      {...props}
    />
  )
}

export {
  Command,
  CommandDialog,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandGroupLabel,
  CommandCollection,
  CommandItem,
  CommandShortcut,
  CommandSeparator,
  CommandPanel,
  CommandFooter,
};
