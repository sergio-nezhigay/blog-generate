import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useNavigate } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return null;
};

export default function AppIndex() {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/app/blog/plan", { replace: true });
  }, [navigate]);
  return null;
}

export function ErrorBoundary() {
  return boundary.error(new Error("Unexpected error"));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
