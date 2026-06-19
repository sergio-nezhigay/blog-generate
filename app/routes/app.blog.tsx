import type { LoaderFunctionArgs } from "react-router";
import { Outlet } from "react-router";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function BlogLayout() {
  return <Outlet />;
}
