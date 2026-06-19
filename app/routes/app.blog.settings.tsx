import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getShopifyBlogs } from "../services/blog/shopifyBlog.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const [blogs, settings] = await Promise.all([
    getShopifyBlogs(admin),
    db.blogSettings.findUnique({ where: { shop: session.shop } }),
  ]);
  return { blogs, settings };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const body = await request.json() as {
    blogId: string;
    blogTitle: string;
    brandName: string;
    ctaUrl: string;
    servicesUrl: string;
    active: boolean;
  };

  await db.blogSettings.upsert({
    where: { shop: session.shop },
    create: { shop: session.shop, ...body },
    update: body,
  });

  return { success: true };
};

export default function BlogSettings() {
  const { blogs, settings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();

  const [blogId, setBlogId] = useState(settings?.blogId ?? "");
  const [blogTitle, setBlogTitle] = useState(settings?.blogTitle ?? "");
  const [brandName, setBrandName] = useState(settings?.brandName ?? "ENCANTO");
  const [ctaUrl, setCtaUrl] = useState(settings?.ctaUrl ?? "/pages/contact");
  const [servicesUrl, setServicesUrl] = useState(settings?.servicesUrl ?? "/pages/collections/all");
  const [active, setActive] = useState(settings?.active ?? false);

  const isSubmitting = fetcher.state !== "idle";
  const saved = fetcher.state === "idle" && fetcher.data?.success;

  const handleBlogChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    const blog = blogs.find((b) => b.id === id);
    setBlogId(id);
    setBlogTitle(blog?.title ?? "");
  };

  const handleSave = () => {
    fetcher.submit(
      { blogId, blogTitle, brandName, ctaUrl, servicesUrl, active },
      { method: "POST", encType: "application/json" },
    );
  };

  return (
    <s-page heading="Blog Automation Settings">
      {saved && (
        <s-banner tone="success">
          Settings saved.
        </s-banner>
      )}

      <s-section heading="Blog">
        <s-stack direction="block" gap="base">
          <div>
            <p style={{ marginBottom: "4px", fontWeight: 500 }}>Shopify Blog</p>
            <select
              value={blogId}
              onChange={handleBlogChange}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid #c9cccf",
                fontSize: "14px",
                background: "#fff",
              }}
            >
              <option value="">— Select a blog —</option>
              {blogs.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.title}
                </option>
              ))}
            </select>
          </div>
        </s-stack>
      </s-section>

      <s-section heading="Brand">
        <s-stack direction="block" gap="base">
          <div>
            <p style={{ marginBottom: "4px", fontWeight: 500 }}>Brand Name</p>
            <input
              type="text"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <p style={{ marginBottom: "4px", fontWeight: 500 }}>CTA URL</p>
            <input
              type="text"
              value={ctaUrl}
              onChange={(e) => setCtaUrl(e.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <p style={{ marginBottom: "4px", fontWeight: 500 }}>
              Collections / Services URL
            </p>
            <input
              type="text"
              value={servicesUrl}
              onChange={(e) => setServicesUrl(e.target.value)}
              style={inputStyle}
            />
          </div>
        </s-stack>
      </s-section>

      <s-section heading="Automation">
        <s-stack direction="inline" gap="base">
          <input
            id="active-toggle"
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          <label htmlFor="active-toggle">Enable daily publishing</label>
        </s-stack>
      </s-section>

      <s-section>
        <s-stack direction="inline" gap="base">
          <s-button
            onClick={handleSave}
            {...(isSubmitting ? { loading: true } : {})}
          >
            Save Settings
          </s-button>
          {blogId && (
            <s-text tone="neutral">
              Blog: {blogTitle || blogId}
            </s-text>
          )}
        </s-stack>
      </s-section>
    </s-page>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 12px",
  borderRadius: "8px",
  border: "1px solid #c9cccf",
  fontSize: "14px",
  boxSizing: "border-box",
};
