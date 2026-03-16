import type { Tool, ToolResult } from "./types.js";
import {
  getFeed,
  getSubmoltFeed,
  createPost,
  createComment,
  upvotePost,
  search,
  getHome,
} from "../moltbook/client.js";

export const moltbookRead: Tool = {
  definition: {
    name: "moltbook_read",
    description:
      "Read posts from Moltbook, the social network for AI agents. " +
      "Use to browse the feed, check a specific submolt (community), search for topics, " +
      "or check your dashboard (karma, notifications, mentions).",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["feed", "submolt", "search", "home"],
          description:
            "What to read. 'feed' = global feed, 'submolt' = community feed, " +
            "'search' = semantic search, 'home' = your dashboard/notifications.",
        },
        query: {
          type: "string",
          description: "Search query (for action=search) or submolt name (for action=submolt).",
        },
        sort: {
          type: "string",
          enum: ["hot", "new", "top", "rising"],
          description: "Sort order. Default: hot.",
        },
      },
      required: ["action"],
    },
  },
  async execute(input): Promise<ToolResult> {
    const action = input.action as string;
    const query = input.query as string | undefined;
    const sort = (input.sort as "hot" | "new" | "top" | "rising") ?? "hot";

    try {
      let result: Record<string, unknown>;
      switch (action) {
        case "feed":
          result = await getFeed(sort, 15);
          break;
        case "submolt":
          if (!query) return { success: false, data: "Missing query (submolt name)" };
          result = await getSubmoltFeed(query, sort as "hot" | "new" | "top", 15);
          break;
        case "search":
          if (!query) return { success: false, data: "Missing query (search terms)" };
          result = await search(query, "all", 15);
          break;
        case "home":
          result = await getHome();
          break;
        default:
          return { success: false, data: `Unknown action: ${action}` };
      }
      return { success: true, data: JSON.stringify(result, null, 2) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: msg };
    }
  },
};

export const moltbookPost: Tool = {
  definition: {
    name: "moltbook_post",
    description:
      "Create a post or comment on Moltbook. Use to share your work, " +
      "engage with other agents, build reputation and visibility. " +
      "Posts go to a submolt (community). Comments reply to existing posts.",
    input_schema: {
      type: "object" as const,
      properties: {
        action: {
          type: "string",
          enum: ["post", "comment", "upvote"],
          description: "What to do: 'post' = create new post, 'comment' = reply to a post, 'upvote' = upvote a post.",
        },
        submolt: {
          type: "string",
          description: "Community name to post in (required for action=post). E.g. 'general', 'coding', 'ai-agents'.",
        },
        title: {
          type: "string",
          description: "Post title (required for action=post). Max 300 chars.",
        },
        content: {
          type: "string",
          description: "Post body or comment text. Max 40,000 chars for posts.",
        },
        post_id: {
          type: "string",
          description: "Post ID to comment on or upvote (required for action=comment/upvote).",
        },
        parent_id: {
          type: "string",
          description: "Parent comment ID for threaded replies (optional for action=comment).",
        },
        url: {
          type: "string",
          description: "URL for link posts (optional for action=post).",
        },
      },
      required: ["action"],
    },
  },
  async execute(input): Promise<ToolResult> {
    const action = input.action as string;

    try {
      switch (action) {
        case "post": {
          const submolt = input.submolt as string;
          const title = input.title as string;
          if (!submolt || !title) return { success: false, data: "Missing submolt or title" };
          const id = await createPost(submolt, title, input.content as string, input.url as string);
          return { success: true, data: `Post created: ${id}` };
        }
        case "comment": {
          const postId = input.post_id as string;
          const content = input.content as string;
          if (!postId || !content) return { success: false, data: "Missing post_id or content" };
          const id = await createComment(postId, content, input.parent_id as string);
          return { success: true, data: `Comment created: ${id}` };
        }
        case "upvote": {
          const postId = input.post_id as string;
          if (!postId) return { success: false, data: "Missing post_id" };
          await upvotePost(postId);
          return { success: true, data: "Upvoted" };
        }
        default:
          return { success: false, data: `Unknown action: ${action}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, data: msg };
    }
  },
};
