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

export interface ShopifyBlog {
  id: string;
  title: string;
}

export interface ShopifyArticle {
  id: string;
  title: string;
  handle: string;
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
): Promise<ShopifyArticle[]> {
  const response = await admin.graphql(`
    query GetArticles($blogId: ID!) {
      blog(id: $blogId) {
        articles(first: 250) {
          nodes {
            id
            title
            handle
          }
        }
      }
    }
  `, { variables: { blogId } });
  const { data } = await response.json() as {
    data: { blog: { articles: { nodes: ShopifyArticle[] } } | null };
  };
  return data.blog?.articles.nodes ?? [];
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
  },
): Promise<{ id: string; handle: string; blogHandle: string }> {
  const metafields: { namespace: string; key: string; value: string; type: string }[] = [];
  if (article.seoTitle?.trim()) {
    metafields.push({ namespace: "global", key: "title_tag", value: article.seoTitle.trim(), type: "single_line_text_field" });
  }
  if (article.metaDescription?.trim()) {
    metafields.push({ namespace: "global", key: "description_tag", value: article.metaDescription.trim(), type: "single_line_text_field" });
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
