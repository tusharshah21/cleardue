import { isDemoMode } from "@/ai/provider";
import { isMockMode } from "@/paypal/client";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  const { DEMO_EMAIL: email, DEMO_PASSWORD: password } = process.env;
  // SHOW_DEMO_LOGIN=true shows the (already public) demo login on the hosted demo, where DEMO_MODE is off.
  const show = (isDemoMode() || isMockMode() || process.env.SHOW_DEMO_LOGIN === "true") && email && password;
  return <LoginForm demo={show ? { email, password } : null} />;
}
