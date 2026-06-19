type AdminGraphQL = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

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
    tags: string;
    published: boolean;
  },
): Promise<{ id: string; handle: string; onlineStoreUrl: string | null }> {
  const response = await admin.graphql(`
    mutation ArticleCreate($blogId: ID!, $article: ArticleCreateInput!) {
      articleCreate(blogId: $blogId, article: $article) {
        article {
          id
          handle
          onlineStoreUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `, {
    variables: {
      blogId,
      article: {
        title: article.title,
        body: article.body_html,
        summary: article.summary_html,
        tags: article.tags,
        isPublished: article.published,
      },
    },
  });

  const { data } = await response.json() as {
    data: {
      articleCreate: {
        article: { id: string; handle: string; onlineStoreUrl: string | null } | null;
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

  return data.articleCreate.article;
}
