type AdminGraphQL = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

// Uploads a base64-encoded JPEG image to Shopify CDN via staged upload.
// Flow: stagedUploadsCreate → PUT binary to GCS → fileCreate with resourceUrl → poll READY.
// Requires write_files scope.
export async function uploadImageToShopifyCDN(
  admin: { graphql: AdminGraphQL },
  b64Jpeg: string,
  altText: string,
): Promise<string> {
  // Step 1: get a staged upload target from Shopify
  const stagedResp = await admin.graphql(`
    mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      input: [{
        filename: "article-image.jpg",
        mimeType: "image/jpeg",
        resource: "IMAGE",
        httpMethod: "PUT",
      }],
    },
  });

  const { data: stagedData, errors: stagedErrors } = await stagedResp.json() as {
    data?: {
      stagedUploadsCreate: {
        stagedTargets: Array<{ url: string; resourceUrl: string; parameters: Array<{ name: string; value: string }> }>;
        userErrors: Array<{ field: string; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (stagedErrors?.length) throw new Error(`stagedUploadsCreate: ${stagedErrors.map(e => e.message).join(", ")}`);
  if (stagedData?.stagedUploadsCreate.userErrors.length) {
    throw new Error(stagedData.stagedUploadsCreate.userErrors.map(e => e.message).join(", "));
  }
  const target = stagedData?.stagedUploadsCreate.stagedTargets[0];
  if (!target) throw new Error("No staged upload target returned");

  // Step 2: PUT the binary to the GCS pre-signed URL
  const buffer = Buffer.from(b64Jpeg, "base64");
  const uploadResp = await fetch(target.url, {
    method: "PUT",
    headers: { "Content-Type": "image/jpeg" },
    body: buffer,
  });
  if (!uploadResp.ok) {
    const txt = await uploadResp.text();
    throw new Error(`GCS PUT failed ${uploadResp.status}: ${txt.slice(0, 200)}`);
  }

  // Step 3: register the file in Shopify via fileCreate
  const fileResp = await admin.graphql(`
    mutation FileCreate($files: [FileCreateInput!]!) {
      fileCreate(files: $files) {
        files {
          id
          fileStatus
          ... on MediaImage { image { url } }
        }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      files: [{ alt: altText, contentType: "IMAGE", originalSource: target.resourceUrl }],
    },
  });

  const { data: fileData, errors: fileErrors } = await fileResp.json() as {
    data?: {
      fileCreate: {
        files: Array<{ id: string; fileStatus: string; image?: { url: string } }>;
        userErrors: Array<{ field: string; message: string }>;
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (fileErrors?.length) throw new Error(`fileCreate: ${fileErrors.map(e => e.message).join(", ")}`);
  if (fileData?.fileCreate.userErrors.length) {
    throw new Error(fileData.fileCreate.userErrors.map(e => e.message).join(", "));
  }
  const file = fileData?.fileCreate.files[0];
  if (!file) throw new Error("fileCreate returned no file");

  if (file.fileStatus === "READY" && file.image?.url) return file.image.url;

  // Step 4: poll until READY (up to 40s)
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const pollResp = await admin.graphql(`
      query GetFileNode($id: ID!) {
        node(id: $id) {
          ... on MediaImage { fileStatus image { url } }
        }
      }
    `, { variables: { id: file.id } });
    const { data: pollData } = await pollResp.json() as {
      data: { node: { fileStatus: string; image?: { url: string } } | null };
    };
    const node = pollData.node;
    if (node?.fileStatus === "READY" && node.image?.url) return node.image.url;
  }

  throw new Error("Image upload timed out waiting for READY status");
}

export async function setArticleHeroImage(
  admin: { graphql: AdminGraphQL },
  articleGid: string,
  imageUrl: string,
  altText: string,
): Promise<void> {
  const resp = await admin.graphql(`
    mutation SetArticleHeroImage($id: ID!, $article: ArticleUpdateInput!) {
      articleUpdate(id: $id, article: $article) {
        article { id }
        userErrors { field message }
      }
    }
  `, {
    variables: { id: articleGid, article: { image: { url: imageUrl, altText } } },
  });
  const { data } = await resp.json() as {
    data: {
      articleUpdate: {
        article: { id: string } | null;
        userErrors: Array<{ field: string; message: string }>;
      };
    };
  };
  if (data.articleUpdate.userErrors.length > 0) {
    console.error("[images] setArticleHeroImage errors:", data.articleUpdate.userErrors);
  }
}

// Resolves a /products/<handle> or /collections/<handle> URL to its real Shopify image.
// Returns null for non-product/collection URLs, missing handles, or items with no image.
export async function getProductOrCollectionImage(
  admin: { graphql: AdminGraphQL },
  url: string,
): Promise<{ imageUrl: string; altText: string } | null> {
  const productMatch = url.match(/^\/products\/([^/?#]+)/);
  const collectionMatch = url.match(/^\/collections\/([^/?#]+)/);
  if (!productMatch && !collectionMatch) return null;

  if (productMatch) {
    const handle = productMatch[1];
    const resp = await admin.graphql(`
      query GetProductImage($handle: String!) {
        productByIdentifier(identifier: { handle: $handle }) {
          featuredMedia { preview { image { url altText } } }
        }
      }
    `, { variables: { handle } });
    const { data } = await resp.json() as {
      data?: { productByIdentifier: { featuredMedia: { preview: { image: { url: string; altText: string | null } | null } | null } | null } | null };
    };
    const image = data?.productByIdentifier?.featuredMedia?.preview?.image;
    return image ? { imageUrl: image.url, altText: image.altText ?? "" } : null;
  }

  const handle = collectionMatch![1];
  const resp = await admin.graphql(`
    query GetCollectionImage($handle: String!) {
      collectionByIdentifier(identifier: { handle: $handle }) {
        image { url altText }
      }
    }
  `, { variables: { handle } });
  const { data } = await resp.json() as {
    data?: { collectionByIdentifier: { image: { url: string; altText: string | null } | null } | null };
  };
  const image = data?.collectionByIdentifier?.image;
  return image ? { imageUrl: image.url, altText: image.altText ?? "" } : null;
}

export interface ShopifyBlog {
  id: string;
  title: string;
}

export interface ShopifyArticle {
  id: string;
  title: string;
  handle: string;
  publishedAt?: string;
}

export async function getShopifyBlogs(admin: { graphql: AdminGraphQL }): Promise<ShopifyBlog[]> {
  const response = await admin.graphql(`
    query GetBlogs {
      blogs(first: 20) {
        nodes {
          id
          title
        }
      }
    }
  `);
  const { data } = await response.json() as { data: { blogs: { nodes: ShopifyBlog[] } } };
  return data.blogs.nodes;
}

export async function getShopifyArticles(
  admin: { graphql: AdminGraphQL },
  blogId: string,
): Promise<{ articles: ShopifyArticle[]; blogHandle: string }> {
  const response = await admin.graphql(`
    query GetArticles($blogId: ID!) {
      blog(id: $blogId) {
        handle
        articles(first: 250) {
          nodes {
            id
            title
            handle
            publishedAt
          }
        }
      }
    }
  `, { variables: { blogId } });
  const json = await response.json() as {
    data?: { blog: { handle: string; articles: { nodes: ShopifyArticle[] } } | null };
    errors?: { message: string }[];
  };
  if (json.errors?.length) {
    console.error("[getShopifyArticles] GraphQL errors:", json.errors.map((e) => e.message).join("; "));
  }
  const blog = json.data?.blog;
  const articles = (blog?.articles.nodes ?? []).slice().sort((a, b) => {
    const da = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const db_ = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return db_ - da;
  });
  return {
    articles,
    blogHandle: blog?.handle ?? "noticias",
  };
}

export async function deleteShopifyArticle(
  admin: { graphql: AdminGraphQL },
  articleId: string,
): Promise<void> {
  const resp = await admin.graphql(`
    mutation ArticleDelete($id: ID!) {
      articleDelete(id: $id) {
        deletedArticleId
        userErrors { field message }
      }
    }
  `, { variables: { id: articleId } });
  const { data } = await resp.json() as {
    data: { articleDelete: { deletedArticleId: string | null; userErrors: Array<{ field: string; message: string }> } };
  };
  if (data.articleDelete.userErrors.length > 0) {
    throw new Error(data.articleDelete.userErrors.map(e => e.message).join(", "));
  }
}

export async function checkArticlesExist(
  admin: { graphql: AdminGraphQL },
  articleIds: string[],
): Promise<Set<string>> {
  if (articleIds.length === 0) return new Set();
  const resp = await admin.graphql(`
    query CheckArticles($ids: [ID!]!) {
      nodes(ids: $ids) { id }
    }
  `, { variables: { ids: articleIds } });
  const { data } = await resp.json() as {
    data: { nodes: Array<{ id: string } | null> };
  };
  return new Set(data.nodes.filter(Boolean).map((n) => (n as { id: string }).id));
}

export async function updateArticlePublished(
  admin: { graphql: AdminGraphQL },
  articleId: string,
): Promise<{ handle: string; blogHandle: string }> {
  const resp = await admin.graphql(`
    mutation ArticlePublish($id: ID!, $article: ArticleUpdateInput!) {
      articleUpdate(id: $id, article: $article) {
        article { id handle blog { handle } }
        userErrors { field message }
      }
    }
  `, { variables: { id: articleId, article: { isPublished: true } } });
  const { data } = await resp.json() as {
    data: { articleUpdate: { article: { id: string; handle: string; blog: { handle: string } } | null; userErrors: Array<{ field: string; message: string }> } };
  };
  if (data.articleUpdate.userErrors.length > 0) {
    throw new Error(data.articleUpdate.userErrors.map(e => e.message).join(", "));
  }
  if (!data.articleUpdate.article) throw new Error("articleUpdate returned no article");
  return {
    handle: data.articleUpdate.article.handle,
    blogHandle: data.articleUpdate.article.blog.handle,
  };
}

export async function getArticleBody(
  admin: { graphql: AdminGraphQL },
  articleGid: string,
): Promise<{ title: string; bodyHtml: string }> {
  const resp = await admin.graphql(`
    query GetArticleBody($id: ID!) {
      article(id: $id) {
        title
        body
      }
    }
  `, { variables: { id: articleGid } });
  const { data } = await resp.json() as {
    data: { article: { title: string; body: string } | null };
  };
  if (!data.article) throw new Error(`Article not found: ${articleGid}`);
  return { title: data.article.title, bodyHtml: data.article.body };
}

export async function updateArticleContent(
  admin: { graphql: AdminGraphQL },
  articleGid: string,
  title: string,
  body: string,
): Promise<void> {
  const resp = await admin.graphql(`
    mutation UpdateArticleContent($id: ID!, $article: ArticleUpdateInput!) {
      articleUpdate(id: $id, article: $article) {
        article { id }
        userErrors { field message }
      }
    }
  `, { variables: { id: articleGid, article: { title, body } } });
  const { data } = await resp.json() as {
    data: { articleUpdate: { article: { id: string } | null; userErrors: Array<{ field: string; message: string }> } };
  };
  if (data.articleUpdate.userErrors.length > 0) {
    throw new Error(data.articleUpdate.userErrors.map(e => e.message).join(", "));
  }
}

export interface TranslatableContent {
  key: string;
  value: string;
  digest: string;
}

export async function getTranslatableContent(
  admin: { graphql: AdminGraphQL },
  resourceGid: string,
): Promise<TranslatableContent[]> {
  const resp = await admin.graphql(`
    query GetTranslatableContent($id: ID!) {
      translatableResource(resourceId: $id) {
        translatableContent {
          key
          value
          digest
        }
      }
    }
  `, { variables: { id: resourceGid } });
  const { data } = await resp.json() as {
    data: { translatableResource: { translatableContent: TranslatableContent[] } | null };
  };
  return data.translatableResource?.translatableContent ?? [];
}

export async function registerTranslations(
  admin: { graphql: AdminGraphQL },
  resourceGid: string,
  locale: string,
  translations: { key: string; value: string; translatableContentDigest: string }[],
): Promise<void> {
  const resp = await admin.graphql(`
    mutation TranslationsRegister($id: ID!, $translations: [TranslationInput!]!) {
      translationsRegister(resourceId: $id, translations: $translations) {
        translations { locale key }
        userErrors { field message }
      }
    }
  `, {
    variables: {
      id: resourceGid,
      translations: translations.map(t => ({ ...t, locale })),
    },
  });
  const { data } = await resp.json() as {
    data: { translationsRegister: { userErrors: Array<{ field: string; message: string }> } };
  };
  if (data.translationsRegister.userErrors.length > 0) {
    throw new Error(data.translationsRegister.userErrors.map(e => e.message).join(", "));
  }
}

export async function publishArticleToShopify(
  admin: { graphql: AdminGraphQL },
  blogId: string,
  article: {
    title: string;
    body_html: string;
    summary_html: string;
    tags: string[];
    published: boolean;
    authorName?: string;
    seoTitle?: string;
    metaDescription?: string;
    faqSchemaJson?: string | null;
  },
): Promise<{ id: string; handle: string; blogHandle: string }> {
  const metafields: { namespace: string; key: string; value: string; type: string }[] = [];
  if (article.seoTitle?.trim()) {
    metafields.push({ namespace: "global", key: "title_tag", value: article.seoTitle.trim(), type: "single_line_text_field" });
  }
  if (article.metaDescription?.trim()) {
    metafields.push({ namespace: "global", key: "description_tag", value: article.metaDescription.trim(), type: "single_line_text_field" });
  }
  if (article.faqSchemaJson) {
    metafields.push({ namespace: "custom", key: "faq_schema", value: article.faqSchemaJson, type: "json" });
  }

  const response = await admin.graphql(`
    mutation ArticleCreate($article: ArticleCreateInput!) {
      articleCreate(article: $article) {
        article {
          id
          handle
          blog {
            handle
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    variables: {
      article: {
        blogId,
        title: article.title,
        body: article.body_html,
        summary: article.summary_html,
        tags: article.tags,
        isPublished: article.published,
        author: { name: article.authorName ?? "ENCANTO" },
        ...(metafields.length > 0 && { metafields }),
      },
    },
  });

  const { data } = await response.json() as {
    data: {
      articleCreate: {
        article: { id: string; handle: string; blog: { handle: string } } | null;
        userErrors: { field: string; message: string }[];
      };
    };
  };

  if (data.articleCreate.userErrors.length > 0) {
    throw new Error(data.articleCreate.userErrors.map(e => e.message).join(', '));
  }
  if (!data.articleCreate.article) {
    throw new Error('Article creation returned no article');
  }

  return {
    id: data.articleCreate.article.id,
    handle: data.articleCreate.article.handle,
    blogHandle: data.articleCreate.article.blog.handle,
  };
}
