import type { ResultRow, Translation } from "./translator/types";
import { translate } from "./translator";
import type { StorageRPC } from "./storage";

interface Env {
  STORAGE: DurableObjectNamespace;
  AUTH_TOKEN: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain" } });
}

/** Validates and normalizes a command in a single pass. */
function toCommand(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: string[] = new Array(value.length);
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") {
      out[i] = item;
    } else if (typeof item === "number") {
      out[i] = String(item);
    } else {
      return null;
    }
  }
  return out;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const textEncoder = new TextEncoder();

/**
 * Base64 encodes UTF-8 bytes directly. `btoa(String.fromCharCode(...bytes))`
 * builds a throwaway latin1 string and blows the call stack on large values.
 */
function base64Encode(value: string): string {
  const bytes = textEncoder.encode(value);
  const length = bytes.length;
  let out = "";
  let i = 0;
  for (; i + 2 < length; i += 3) {
    const triple = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out +=
      BASE64_ALPHABET[(triple >> 18) & 63] +
      BASE64_ALPHABET[(triple >> 12) & 63] +
      BASE64_ALPHABET[(triple >> 6) & 63] +
      BASE64_ALPHABET[triple & 63];
  }
  const remaining = length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    out += BASE64_ALPHABET[(chunk >> 18) & 63] + BASE64_ALPHABET[(chunk >> 12) & 63] + "==";
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out +=
      BASE64_ALPHABET[(chunk >> 18) & 63] +
      BASE64_ALPHABET[(chunk >> 12) & 63] +
      BASE64_ALPHABET[(chunk >> 6) & 63] +
      "=";
  }
  return out;
}

function encodeResult(v: unknown): unknown {
  if (typeof v === "string") {
    return base64Encode(v);
  }
  if (Array.isArray(v)) {
    return v.map(encodeResult);
  }
  return v;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return textResponse("Unauthorized", 401);
    }
    const token = authHeader.slice("Bearer ".length);
    if (!env.AUTH_TOKEN || token !== env.AUTH_TOKEN) {
      return textResponse("Unauthorized", 401);
    }

    if (request.method !== "POST") {
      return textResponse("Method Not Allowed", 405);
    }

    const base64Encoding = request.headers.get("Upstash-Encoding") === "base64";

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse({ error: "ERR invalid request body" });
    }

    if (!Array.isArray(payload)) {
      return jsonResponse({ error: "ERR invalid request body" });
    }

    const id = env.STORAGE.idFromName("global");
    const stub = env.STORAGE.get(id) as DurableObjectStub & StorageRPC;

    const single = toCommand(payload);
    if (single) {
      const cmd = single;
      if (cmd.length === 1 && cmd[0].toUpperCase() === "INIT") {
        try {
          await stub.init();
          const result = base64Encoding ? encodeResult("OK") : "OK";
          return jsonResponse({ result });
        } catch (err) {
          return jsonResponse({ error: errorMessage(err) });
        }
      }

      let translation: Translation;
      try {
        translation = translate(cmd);
      } catch (err) {
        return jsonResponse({ error: errorMessage(err) });
      }

      let results: ResultRow[][] = [];
      if (translation.statements.length > 0) {
        try {
          results = await stub.execBatch(translation.statements);
        } catch (err) {
          return jsonResponse({ error: errorMessage(err) });
        }
      }

      try {
        const mapped = translation.mapResult(results);
        const result = base64Encoding ? encodeResult(mapped) : mapped;
        return jsonResponse({ result });
      } catch (err) {
        return jsonResponse({ error: errorMessage(err) });
      }
    }

    const pipeline: string[][] = new Array(payload.length);
    for (let i = 0; i < payload.length; i++) {
      const cmd = toCommand(payload[i]);
      if (!cmd) {
        return jsonResponse({ error: "ERR invalid request body" });
      }
      pipeline[i] = cmd;
    }

    const results: unknown[] = new Array(pipeline.length);
    const translations: Translation[] = [];
    const indexMap: number[] = [];

    for (let i = 0; i < pipeline.length; i++) {
      try {
        const translation = translate(pipeline[i]);
        translations.push(translation);
        indexMap.push(i);
      } catch (err) {
        results[i] = { error: errorMessage(err) };
      }
    }

    let pipelineResults: ResultRow[][][] = [];
    if (translations.length > 0) {
      try {
        pipelineResults = await stub.execPipeline(
          translations.map((translation) => translation.statements)
        );
      } catch (err) {
        return jsonResponse({ error: errorMessage(err) });
      }
    }

    for (let i = 0; i < translations.length; i++) {
      const translation = translations[i];
      const resultIndex = indexMap[i];
      try {
        const mapped = translation.mapResult(pipelineResults[i] ?? []);
        results[resultIndex] = base64Encoding ? encodeResult(mapped) : mapped;
      } catch (err) {
        results[resultIndex] = { error: errorMessage(err) };
      }
    }

    return jsonResponse({ result: results });
  },
};
