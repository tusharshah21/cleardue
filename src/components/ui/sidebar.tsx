"use client";

// Animated sidebar: a rail that expands on hover (desktop) and a full-screen menu behind a button (mobile).
// Based on the Aceternity-style sidebar; colours use the app's sidebar tokens so it follows the theme.
import { cn } from "@/lib/utils";
import Link from "next/link";
import React, { useState, createContext, useContext } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, X } from "lucide-react";

interface Links {
  label: string;
  href: string;
  icon: React.JSX.Element | React.ReactNode;
}

interface SidebarContextProps {
  open: boolean;
  setOpen: React.Dispatch<React.SetStateAction<boolean>>;
  animate: boolean;
}

const SidebarContext = createContext<SidebarContextProps | undefined>(undefined);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return context;
};

export const SidebarProvider = ({
  children,
  open: openProp,
  setOpen: setOpenProp,
  animate = true,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  const [openState, setOpenState] = useState(false);

  const open = openProp !== undefined ? openProp : openState;
  const setOpen = setOpenProp !== undefined ? setOpenProp : setOpenState;

  return <SidebarContext.Provider value={{ open, setOpen, animate }}>{children}</SidebarContext.Provider>;
};

export const Sidebar = ({
  children,
  open,
  setOpen,
  animate,
}: {
  children: React.ReactNode;
  open?: boolean;
  setOpen?: React.Dispatch<React.SetStateAction<boolean>>;
  animate?: boolean;
}) => {
  return (
    <SidebarProvider open={open} setOpen={setOpen} animate={animate}>
      {children}
    </SidebarProvider>
  );
};

export const SidebarBody = ({ bar, ...props }: React.ComponentProps<typeof motion.div> & { bar?: React.ReactNode }) => {
  return (
    <>
      <DesktopSidebar {...props} />
      <MobileSidebar bar={bar} {...(props as React.ComponentProps<"div">)} />
    </>
  );
};

export const DesktopSidebar = ({ className, children, ...props }: React.ComponentProps<typeof motion.div>) => {
  const { open, setOpen, animate } = useSidebar();
  return (
    <motion.div
      className={cn("hidden h-full w-[300px] flex-shrink-0 bg-sidebar px-4 py-4 text-sidebar-foreground md:flex md:flex-col", className)}
      animate={{
        width: animate ? (open ? "240px" : "60px") : "240px",
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
      }}
      {...props}
    >
      {children}
    </motion.div>
  );
};

export const MobileSidebar = ({ className, children, bar, ...props }: React.ComponentProps<"div"> & { bar?: React.ReactNode }) => {
  const { open, setOpen } = useSidebar();
  return (
    <>
      <div className="flex h-12 w-full flex-row items-center justify-between border-b bg-sidebar px-4 md:hidden" {...props}>
        <div className="z-20">{bar}</div>
        <div className="z-20 flex justify-end">
          <button type="button" aria-label="Open menu" aria-expanded={open} onClick={() => setOpen(!open)} className="rounded-md p-1 text-sidebar-foreground">
            <Menu />
          </button>
        </div>
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ x: "-100%", opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: "-100%", opacity: 0 }}
              transition={{
                duration: 0.3,
                ease: "easeInOut",
              }}
              className={cn("fixed inset-0 z-[100] flex h-full w-full flex-col justify-between bg-background p-10 text-foreground", className)}
            >
              <button type="button" aria-label="Close menu" className="absolute top-10 right-10 z-50 cursor-pointer" onClick={() => setOpen(false)}>
                <X />
              </button>
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
};

export const SidebarLink = ({
  link,
  className,
  active,
  label,
  ...props
}: {
  link: Links;
  className?: string;
  /** The page this link points at is the one open. */
  active?: boolean;
  /** Accessible name when it differs from the visible label (the label is hidden while the rail is collapsed). */
  label?: string;
} & Omit<React.ComponentProps<typeof Link>, "href" | "className" | "children">) => {
  const { open, animate } = useSidebar();
  return (
    <Link
      href={link.href}
      aria-label={label ?? link.label}
      aria-current={active ? "page" : undefined}
      className={cn("group/sidebar -mx-2 flex items-center justify-start gap-2 rounded-md px-2 py-2 hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent", className)}
      {...props}
    >
      {link.icon}
      <motion.span
        animate={{
          display: animate ? (open ? "inline-block" : "none") : "inline-block",
          opacity: animate ? (open ? 1 : 0) : 1,
        }}
        className="inline-block !m-0 !p-0 text-sm whitespace-pre text-sidebar-foreground transition duration-150 group-hover/sidebar:translate-x-1 group-aria-[current=page]/sidebar:font-medium"
      >
        {link.label}
      </motion.span>
    </Link>
  );
};
