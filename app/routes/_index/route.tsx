import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  const params = new URLSearchParams(url.searchParams);
  if (!params.has("shop")) params.set("shop", "drmtdf-we.myshopify.com");
  throw redirect(`/app?${params.toString()}`);
};

export default function App() {
  return null;
}
