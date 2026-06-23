import { useEffect, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  QA_CATEGORIES,
  FASHION_CATEGORIES,
  getFullQAPool,
  getAllFashionCategories,
  type ContentCategory,
} from "../services/blog/contentPlanner.server";
import {
  suggestQAQuestions,
  suggestFashionCategory,
} from "../services/blog/poolSuggester.server";

// ---- Loader ----

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const settings = await db.blogSettings.findUnique({ where: { shop } });

  // Count published articles per QA category
  const publishedGroups = await db.blogContentPlan.groupBy({
    by: ["category"],
    where: { shop, status: "published" },
    _count: { _all: true },
  });
  const publishedByCategory: Record<string, number> = {};
  for (const g of publishedGroups) {
    publishedByCategory[g.category] = g._count._all;
  }

  const extendedQA = (settings?.extendedQAQuestions as Record<string, string[]>) ?? {};
  const extendedFashion = (settings?.extendedFashionCategories as Array<{
    name: string; format: string; titlePattern: string; targetWordCount: number;
  }>) ?? [];

  const qaStats = QA_CATEGORIES.map((cat) => {
    const baseCount = cat.questionPool?.length ?? 0;
    const extCount = extendedQA[cat.name]?.length ?? 0;
    const total = baseCount + extCount;
    const used = publishedByCategory[cat.name] ?? 0;
    const remaining = Math.max(0, total - used);
    return {
      name: cat.name,
      baseCount,
      extendedQuestions: extendedQA[cat.name] ?? [],
      total,
      used,
      remaining,
    };
  });

  const fashionStats = {
    hardcoded: FASHION_CATEGORIES.map((c) => ({
      name: c.name,
      format: c.format,
      titlePattern: c.titlePattern,
      targetWordCount: c.targetWordCount,
    })),
    extended: extendedFashion,
  };

  return { qaStats, fashionStats, hasSettings: !!settings };
};

// ---- Action ----

type ActionData =
  | { ok: true }
  | { ok: true; suggestions: string[] }
  | { ok: true; fashionCategory: { name: string; format: string; titlePattern: string; targetWordCount: number } }
  | { ok: false; error: string };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData> => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const body = await request.json() as {
    intent: string;
    categoryName?: string;
    question?: string;
    fashionCategory?: { name: string; format: string; titlePattern: string; targetWordCount: number };
  };

  const settings = await db.blogSettings.findUnique({ where: { shop } });
  if (!settings) return { ok: false, error: "No settings found. Configure the blog first." };

  if (body.intent === "generateQASuggestions") {
    const categoryName = body.categoryName!;
    const currentPool = getFullQAPool(settings, categoryName);
    const suggestions = await suggestQAQuestions(categoryName, currentPool, settings.brandName);
    return { ok: true, suggestions };
  }

  if (body.intent === "saveQAQuestion") {
    const categoryName = body.categoryName!;
    const question = body.question!.trim();
    const extendedQA = (settings.extendedQAQuestions as Record<string, string[]>) ?? {};
    const existing = extendedQA[categoryName] ?? [];
    if (!existing.includes(question)) {
      await db.blogSettings.update({
        where: { shop },
        data: {
          extendedQAQuestions: { ...extendedQA, [categoryName]: [...existing, question] },
        },
      });
    }
    return { ok: true };
  }

  if (body.intent === "removeQAQuestion") {
    const categoryName = body.categoryName!;
    const question = body.question!;
    const extendedQA = (settings.extendedQAQuestions as Record<string, string[]>) ?? {};
    const filtered = (extendedQA[categoryName] ?? []).filter((q) => q !== question);
    await db.blogSettings.update({
      where: { shop },
      data: {
        extendedQAQuestions: { ...extendedQA, [categoryName]: filtered },
      },
    });
    return { ok: true };
  }

  if (body.intent === "generateFashionCategory") {
    const allCategories = getAllFashionCategories(settings);
    const fashionCategory = await suggestFashionCategory(allCategories, settings.brandName);
    return { ok: true, fashionCategory };
  }

  if (body.intent === "saveFashionCategory") {
    const newCat = body.fashionCategory!;
    const extendedFashion = (settings.extendedFashionCategories as Array<{
      name: string; format: string; titlePattern: string; targetWordCount: number;
    }>) ?? [];
    await db.blogSettings.update({
      where: { shop },
      data: {
        extendedFashionCategories: [...extendedFashion, newCat],
      },
    });
    return { ok: true };
  }

  if (body.intent === "removeFashionCategory") {
    const nameToRemove = body.categoryName!;
    const extendedFashion = (settings.extendedFashionCategories as Array<{
      name: string; format: string; titlePattern: string; targetWordCount: number;
    }>) ?? [];
    await db.blogSettings.update({
      where: { shop },
      data: {
        extendedFashionCategories: extendedFashion.filter((c) => c.name !== nameToRemove),
      },
    });
    return { ok: true };
  }

  return { ok: false, error: "Unknown intent" };
};

// ---- Component ----

function runwayLabel(remaining: number): string {
  if (remaining <= 3) return "🔴 Critical";
  if (remaining <= 8) return "🟡 Low";
  return "🟢 Good";
}

export default function BlogPools() {
  const { qaStats, fashionStats, hasSettings } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();

  // Which QA category is currently generating suggestions
  const [activeQACategory, setActiveQACategory] = useState<string | null>(null);
  // Pending suggestions per category (cleared on add/skip)
  const [pendingSuggestions, setPendingSuggestions] = useState<string[]>([]);
  // Manual question input per category
  const [manualInputs, setManualInputs] = useState<Record<string, string>>({});
  // Proposed new fashion category from AI
  const [proposedFashion, setProposedFashion] = useState<{
    name: string; format: string; titlePattern: string; targetWordCount: number;
  } | null>(null);
  // Editable fields for the fashion proposal
  const [editingFashion, setEditingFashion] = useState<{
    name: string; format: string; titlePattern: string; targetWordCount: number;
  } | null>(null);

  const isGenerating = fetcher.state !== "idle";

  useEffect(() => {
    if (!fetcher.data || !("ok" in fetcher.data)) return;
    const data = fetcher.data;
    if (data.ok && "suggestions" in data) {
      setPendingSuggestions(data.suggestions);
    }
    if (data.ok && "fashionCategory" in data) {
      setProposedFashion(data.fashionCategory);
      setEditingFashion({ ...data.fashionCategory });
    }
  }, [fetcher.data]);

  function submitJSON(body: Record<string, unknown>) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetcher.submit(body as any, { method: "POST", encType: "application/json" });
  }

  function handleGenerateQA(categoryName: string) {
    setActiveQACategory(categoryName);
    setPendingSuggestions([]);
    submitJSON({ intent: "generateQASuggestions", categoryName });
  }

  function handleAddSuggestion(categoryName: string, question: string) {
    setPendingSuggestions((prev) => prev.filter((q) => q !== question));
    submitJSON({ intent: "saveQAQuestion", categoryName, question });
  }

  function handleSkipSuggestion(question: string) {
    setPendingSuggestions((prev) => prev.filter((q) => q !== question));
  }

  function handleRemoveExtended(categoryName: string, question: string) {
    submitJSON({ intent: "removeQAQuestion", categoryName, question });
  }

  function handleManualAdd(categoryName: string) {
    const question = manualInputs[categoryName]?.trim();
    if (!question) return;
    setManualInputs((prev) => ({ ...prev, [categoryName]: "" }));
    submitJSON({ intent: "saveQAQuestion", categoryName, question });
  }

  function handleGenerateFashion() {
    setProposedFashion(null);
    setEditingFashion(null);
    submitJSON({ intent: "generateFashionCategory" });
  }

  function handleSaveFashion() {
    if (!editingFashion) return;
    submitJSON({ intent: "saveFashionCategory", fashionCategory: editingFashion });
    setProposedFashion(null);
    setEditingFashion(null);
  }

  function handleRemoveFashion(name: string) {
    submitJSON({ intent: "removeFashionCategory", categoryName: name });
  }

  if (!hasSettings) {
    return (
      <s-page heading="Content Pool Manager">
        <s-banner tone="warning">
          Configure the blog in Settings first before managing pools.
        </s-banner>
      </s-page>
    );
  }

  return (
    <s-page heading="Content Pool Manager">
      <s-section heading="QA Question Pools">
        <p style={{ color: "#6d7175", marginBottom: "16px", fontSize: "14px" }}>
          Each QA week publishes one article per product, drawing from these question pools.
          Add more questions to extend the runway before topics repeat.
        </p>

        {qaStats.map((cat) => {
          const isActiveCategory = activeQACategory === cat.name;
          const showSuggestions = isActiveCategory && pendingSuggestions.length > 0;
          const isLoadingThis = isGenerating && isActiveCategory;

          return (
            <div
              key={cat.name}
              style={{
                marginBottom: "24px",
                padding: "16px",
                border: "1px solid #e1e3e5",
                borderRadius: "8px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "8px" }}>
                <div>
                  <strong style={{ fontSize: "14px" }}>{cat.name}</strong>
                  <span style={{ marginLeft: "12px", fontSize: "13px", color: "#6d7175" }}>
                    {cat.total} questions total · {cat.used} published · {cat.remaining} remaining
                  </span>
                  <span style={{ marginLeft: "8px", fontSize: "12px" }}>
                    {runwayLabel(cat.remaining)}
                  </span>
                </div>
                <s-button
                  onClick={() => handleGenerateQA(cat.name)}
                  variant="secondary"
                  {...(isLoadingThis ? { loading: true } : {})}
                >
                  Suggest 10 more
                </s-button>
              </div>

              {/* Base pool count */}
              <p style={{ fontSize: "12px", color: "#8c9196", margin: "4px 0" }}>
                {cat.baseCount} hardcoded · {cat.extendedQuestions.length} added by you
              </p>

              {/* Extended questions */}
              {cat.extendedQuestions.length > 0 && (
                <div style={{ marginTop: "8px" }}>
                  {cat.extendedQuestions.map((q) => (
                    <div
                      key={q}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "4px 8px",
                        marginBottom: "4px",
                        background: "#f6f6f7",
                        borderRadius: "4px",
                        fontSize: "13px",
                      }}
                    >
                      <span>{q}</span>
                      <button
                        onClick={() => handleRemoveExtended(cat.name, q)}
                        style={{ border: "none", background: "none", color: "#d72c0d", cursor: "pointer", fontSize: "12px", padding: "2px 6px" }}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* AI suggestions */}
              {showSuggestions && (
                <div style={{ marginTop: "12px" }}>
                  <p style={{ fontSize: "12px", fontWeight: 600, marginBottom: "6px", color: "#2c6ecb" }}>
                    AI Suggestions — click ✓ to add, ✕ to skip:
                  </p>
                  {pendingSuggestions.map((q) => (
                    <div
                      key={q}
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        padding: "6px 8px",
                        marginBottom: "4px",
                        background: "#ebf5fe",
                        borderRadius: "4px",
                        fontSize: "13px",
                        border: "1px solid #c4dbf6",
                      }}
                    >
                      <span>{q}</span>
                      <span style={{ whiteSpace: "nowrap", marginLeft: "8px" }}>
                        <button
                          onClick={() => handleAddSuggestion(cat.name, q)}
                          style={{ border: "none", background: "none", color: "#2c6ecb", cursor: "pointer", fontWeight: 700, padding: "2px 6px" }}
                          title="Add to pool"
                        >
                          ✓
                        </button>
                        <button
                          onClick={() => handleSkipSuggestion(q)}
                          style={{ border: "none", background: "none", color: "#6d7175", cursor: "pointer", padding: "2px 6px" }}
                          title="Skip"
                        >
                          ✕
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Manual add */}
              <div style={{ display: "flex", gap: "8px", marginTop: "10px" }}>
                <input
                  type="text"
                  placeholder="Add a question manually…"
                  value={manualInputs[cat.name] ?? ""}
                  onChange={(e) => setManualInputs((prev) => ({ ...prev, [cat.name]: e.target.value }))}
                  onKeyDown={(e) => e.key === "Enter" && handleManualAdd(cat.name)}
                  style={inputStyle}
                />
                <s-button
                  onClick={() => handleManualAdd(cat.name)}
                  variant="secondary"
                >
                  Add
                </s-button>
              </div>
            </div>
          );
        })}
      </s-section>

      <s-section heading="Fashion Week Categories">
        <p style={{ color: "#6d7175", marginBottom: "16px", fontSize: "14px" }}>
          Fashion weeks publish articles from these category templates. Add new categories to increase variety.
          When more than 7 exist, the planner rotates through them week by week.
        </p>

        {/* Hardcoded categories */}
        <div style={{ marginBottom: "16px" }}>
          <p style={{ fontSize: "12px", fontWeight: 600, color: "#6d7175", marginBottom: "8px" }}>
            BUILT-IN CATEGORIES ({fashionStats.hardcoded.length})
          </p>
          {fashionStats.hardcoded.map((cat) => (
            <div
              key={cat.name}
              style={{
                padding: "8px 12px",
                marginBottom: "4px",
                background: "#f6f6f7",
                borderRadius: "4px",
                fontSize: "13px",
              }}
            >
              <strong>{cat.name}</strong>
              <span style={{ color: "#6d7175", marginLeft: "8px" }}>({cat.format})</span>
              <br />
              <span style={{ color: "#8c9196", fontSize: "12px" }}>{cat.titlePattern}</span>
            </div>
          ))}
        </div>

        {/* Extended categories */}
        {fashionStats.extended.length > 0 && (
          <div style={{ marginBottom: "16px" }}>
            <p style={{ fontSize: "12px", fontWeight: 600, color: "#2c6ecb", marginBottom: "8px" }}>
              YOUR CATEGORIES ({fashionStats.extended.length})
            </p>
            {fashionStats.extended.map((cat) => (
              <div
                key={cat.name}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  padding: "8px 12px",
                  marginBottom: "4px",
                  background: "#ebf5fe",
                  borderRadius: "4px",
                  fontSize: "13px",
                  border: "1px solid #c4dbf6",
                }}
              >
                <div>
                  <strong>{cat.name}</strong>
                  <span style={{ color: "#6d7175", marginLeft: "8px" }}>({cat.format})</span>
                  <br />
                  <span style={{ color: "#8c9196", fontSize: "12px" }}>{cat.titlePattern}</span>
                </div>
                <button
                  onClick={() => handleRemoveFashion(cat.name)}
                  style={{ border: "none", background: "none", color: "#d72c0d", cursor: "pointer", fontSize: "12px", padding: "2px 6px", flexShrink: 0 }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        {/* AI propose new category */}
        {!proposedFashion && (
          <s-button
            onClick={handleGenerateFashion}
            variant="secondary"
            {...(isGenerating && !activeQACategory ? { loading: true } : {})}
          >
            Suggest a new category
          </s-button>
        )}

        {editingFashion && (
          <div
            style={{
              marginTop: "16px",
              padding: "16px",
              border: "1px solid #c4dbf6",
              borderRadius: "8px",
              background: "#ebf5fe",
            }}
          >
            <p style={{ fontSize: "13px", fontWeight: 600, marginBottom: "12px", color: "#2c6ecb" }}>
              AI Suggestion — review and edit before saving:
            </p>
            <div style={{ display: "grid", gap: "8px" }}>
              <div>
                <label style={labelStyle}>Slug (kebab-case)</label>
                <input
                  type="text"
                  value={editingFashion.name}
                  onChange={(e) => setEditingFashion((p) => p ? { ...p, name: e.target.value } : p)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Format</label>
                <select
                  value={editingFashion.format}
                  onChange={(e) => setEditingFashion((p) => p ? { ...p, format: e.target.value } : p)}
                  style={inputStyle}
                >
                  {["listicle", "comparison", "evergreen-guide", "technical", "qa-deepdive"].map((f) => (
                    <option key={f} value={f}>{f}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={labelStyle}>Title Pattern</label>
                <input
                  type="text"
                  value={editingFashion.titlePattern}
                  onChange={(e) => setEditingFashion((p) => p ? { ...p, titlePattern: e.target.value } : p)}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={labelStyle}>Target Word Count</label>
                <input
                  type="number"
                  value={editingFashion.targetWordCount}
                  onChange={(e) => setEditingFashion((p) => p ? { ...p, targetWordCount: Number(e.target.value) } : p)}
                  style={{ ...inputStyle, width: "120px" }}
                />
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "12px" }}>
              <s-button onClick={handleSaveFashion}>Add Category</s-button>
              <s-button
                variant="secondary"
                onClick={() => { setProposedFashion(null); setEditingFashion(null); }}
              >
                Discard
              </s-button>
              <s-button
                variant="secondary"
                onClick={handleGenerateFashion}
                {...(isGenerating ? { loading: true } : {})}
              >
                Regenerate
              </s-button>
            </div>
          </div>
        )}
      </s-section>
    </s-page>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid #c9cccf",
  fontSize: "13px",
  boxSizing: "border-box",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: "12px",
  fontWeight: 500,
  marginBottom: "4px",
  color: "#6d7175",
};
