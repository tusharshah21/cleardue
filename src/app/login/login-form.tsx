"use client";

import Image from "next/image";
import { useActionState } from "react";
import { loginAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** `demo` is the demo login, shown and prefilled only in DEMO_MODE or PayPal mock mode. */
export function LoginForm({ demo }: { demo: { email: string; password: string } | null }) {
  const [state, action, pending] = useActionState(loginAction, {});
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <Image src="/brand/cleardue-logo.png" alt="ClearDue: get paid without chasing" width={640} height={202} className="mb-2 h-auto w-56" priority />
          <CardTitle className="sr-only">ClearDue</CardTitle>
          <CardDescription>Sign in to the demo freelancer account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {demo && (
            <div className="rounded-lg bg-muted p-3 text-sm">
              <p className="font-medium">Demo login</p>
              <p className="mt-1 text-muted-foreground">
                Email <code className="text-foreground">{demo.email}</code>, password <code className="text-foreground">{demo.password}</code>. It&apos;s filled in below.
              </p>
            </div>
          )}
          <form action={action} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="username" defaultValue={demo?.email} required />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" defaultValue={demo?.password} required />
            </div>
            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Signing in…" : "Sign in"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
