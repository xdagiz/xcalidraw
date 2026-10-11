import type { UpdateStatus } from "@shared/ipc";
import { CheckIcon, DownloadIcon, RotateCwIcon } from "lucide-react";

import { SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { toast } from "@/components/ui/toast";
import { toAppError } from "@/lib/app-error";
import { useUpdatesStore } from "@/lib/updates";

const PROGRESS_RADIUS = 7;
const PROGRESS_CIRCUMFERENCE = 2 * Math.PI * PROGRESS_RADIUS;

const clampPercent = (percent: number) =>
  Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;

const DownloadingIcon = ({ percent }: { percent: number }) => {
  const offset = PROGRESS_CIRCUMFERENCE * (1 - clampPercent(percent) / 100);

  return (
    <span className="relative grid size-4 place-items-center">
      <svg aria-hidden viewBox="0 0 16 16" className="absolute inset-0 size-full -rotate-90">
        <circle
          cx="8"
          cy="8"
          r={PROGRESS_RADIUS}
          fill="none"
          strokeWidth={1.5}
          className="stroke-current opacity-25"
        />
        <circle
          cx="8"
          cy="8"
          r={PROGRESS_RADIUS}
          fill="none"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={PROGRESS_CIRCUMFERENCE}
          strokeDashoffset={offset}
          className="stroke-current transition-[stroke-dashoffset] duration-300 ease-out motion-reduce:transition-none"
        />
      </svg>
      <DownloadIcon className="size-2.5!" />
    </span>
  );
};

const DownloadedIcon = () => (
  <span className="relative grid size-4 place-items-center">
    <RotateCwIcon />
    <span className="bg-foreground text-background absolute -right-1 -bottom-1 grid size-2.5 place-items-center rounded-full">
      <CheckIcon className="size-1.5!" strokeWidth={3} />
    </span>
  </span>
);

const downloadUpdate = () => {
  void window.api.updates.download().catch((error) => {
    toast.add({
      title: "Couldn’t download the update",
      description: toAppError(error, "unexpected").detail,
      type: "error",
    });
  });
};

const installUpdate = () => {
  void window.api.updates.install().catch((error) => {
    toast.add({
      title: "Couldn’t install the update",
      description: toAppError(error, "unexpected").detail,
      type: "error",
    });
  });
};

type UpdateActions = {
  download: () => void;
  install: () => void;
};

const describeStatus = (status: UpdateStatus, actions: UpdateActions) => {
  if (status.state === "available") {
    return {
      icon: <DownloadIcon />,
      label: "Download update",
      disabled: false,
      onClick: actions.download,
    };
  }

  if (status.state === "downloading") {
    const percent = Math.round(clampPercent(status.percent));
    return {
      icon: <DownloadingIcon percent={status.percent} />,
      label: `Downloading update… ${percent}%`,
      disabled: true,
    };
  }

  if (status.state === "downloaded") {
    return {
      icon: <DownloadedIcon />,
      label: "Restart to update",
      disabled: false,
      onClick: actions.install,
    };
  }

  return null;
};

export const UpdateIndicator = () => {
  const status = useUpdatesStore((s) => s.status);
  const presentation = describeStatus(status, {
    download: downloadUpdate,
    install: installUpdate,
  });
  if (!presentation) return null;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        className="bg-sidebar-accent/80 disabled:opacity-100"
        disabled={presentation.disabled}
        onClick={presentation?.onClick}
      >
        {presentation.icon}
        <span>{presentation.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
};
