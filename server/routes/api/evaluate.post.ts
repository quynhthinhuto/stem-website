import { defineEventHandler, readMultipartFormData, setResponseStatus } from "h3";

const MAX_FILE_BYTES = 8 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "txt",
  "rtf",
  "odt",
]);

const ALLOWED_SUBJECTS = new Set([
  "Maths",
  "Physics",
  "Chemistry",
  "Biology",
  "Engineering",
  "IT",
]);

const ALLOWED_GRADES = new Set(["8", "9", "10", "11", "12"]);

const evaluationSchema = {
  type: "object",
  properties: {
    overall_score: { type: "integer", minimum: 0, maximum: 100 },
    summary: { type: "string" },
    strengths: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["title", "evidence"],
        additionalProperties: false,
      },
    },
    areas_to_improve: {
      type: "array",
      minItems: 2,
      maxItems: 5,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          evidence: { type: "string" },
          recommendation: { type: "string" },
        },
        required: ["title", "evidence", "recommendation"],
        additionalProperties: false,
      },
    },
    priority_actions: {
      type: "array",
      minItems: 3,
      maxItems: 5,
      items: { type: "string" },
    },
    rubric_scores: {
      type: "array",
      minItems: 8,
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          criterion: { type: "string" },
          score: { type: "integer" },
          max_score: { type: "integer" },
          rationale: { type: "string" },
        },
        required: ["criterion", "score", "max_score", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "overall_score",
    "summary",
    "strengths",
    "areas_to_improve",
    "priority_actions",
    "rubric_scores",
  ],
  additionalProperties: false,
};

function extensionOf(filename: string) {
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() || "" : "";
}

function getOutputText(payload: any) {
  if (typeof payload?.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text;
  }

  if (!Array.isArray(payload?.output)) return "";

  const textParts: string[] = [];

  for (const item of payload.output) {
    if (!item || typeof item !== "object") continue;
    if (!Array.isArray(item.content)) continue;

    for (const part of item.content) {
      if (
        part &&
        typeof part === "object" &&
        part.type === "output_text" &&
        typeof part.text === "string"
      ) {
        textParts.push(part.text);
      }
    }
  }

  return textParts.join("");
}

function parseEvaluation(outputText: string) {
  const trimmed = outputText.trim();

  if (!trimmed) return null;

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const objectStart = withoutFence.indexOf("{");
  const objectEnd = withoutFence.lastIndexOf("}");

  const candidates = [
    trimmed,
    withoutFence,
    objectStart >= 0 && objectEnd > objectStart
      ? withoutFence.slice(objectStart, objectEnd + 1)
      : "",
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;

    try {
      return JSON.parse(candidate);
    } catch {}
  }

  return null;
}

async function requestEvaluation(
  apiKey: string,
  filename: string,
  fileData: string,
  extension: string,
  prompt: string
) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-6-luna",
      store: false,
      reasoning: { effort: "none" },
      max_output_tokens: 8000,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename,
              file_data: fileData,
              ...(extension === "pdf" ? { detail: "low" } : {}),
            },
            {
              type: "input_text",
              text: prompt,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "emi_lesson_plan_evaluation",
          strict: true,
          schema: evaluationSchema,
        },
      },
    }),
  });

  let payload: any = {};

  try {
    payload = await response.json();
  } catch {}

  return { response, payload };
}

function upstreamError(payload: any) {
  return typeof payload?.error?.message === "string"
    ? payload.error.message
    : "";
}

export default defineEventHandler(async (event) => {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    setResponseStatus(event, 503);
    return {
      error: "The lesson-plan evaluator is not configured yet.",
    };
  }

  const form = await readMultipartFormData(event);

  if (!form) {
    setResponseStatus(event, 400);
    return {
      error: "The uploaded form could not be read.",
    };
  }

  const getField = (name: string) =>
    form.find((item) => item.name === name);

  const filePart = getField("lesson_plan");
  const subject = getField("subject")?.data?.toString() || "";
  const grade = getField("grade")?.data?.toString() || "";
  const teacherNotes =
    (getField("teacher_notes")?.data?.toString() || "").slice(0, 2000);

  if (!filePart?.data || !filePart.filename) {
    setResponseStatus(event, 400);
    return {
      error: "Please select a lesson-plan file.",
    };
  }

  if (
    !ALLOWED_SUBJECTS.has(subject) ||
    (grade && !ALLOWED_GRADES.has(grade))
  ) {
    setResponseStatus(event, 400);
    return {
      error: "The selected subject or grade is not valid.",
    };
  }

  if (
    filePart.data.length === 0 ||
    filePart.data.length > MAX_FILE_BYTES
  ) {
    setResponseStatus(event, 400);
    return {
      error: "The file must be between 1 byte and 8 MB.",
    };
  }

  const extension = extensionOf(filePart.filename);

  if (!ALLOWED_EXTENSIONS.has(extension)) {
    setResponseStatus(event, 400);
    return {
      error: "Upload a PDF, Word, TXT, RTF, or ODT lesson plan.",
    };
  }

  const mimeType =
    filePart.type || "application/octet-stream";

  const fileData =
    `data:${mimeType};base64,${filePart.data.toString("base64")}`;

  const prompt = [
    `Evaluate the uploaded ${subject}${grade ? ` Grade ${grade}` : ""} EMI lesson plan for use in Vietnam.`,
    "Use this 100-point rubric: curriculum alignment and subject accuracy (20); content and language objectives (15); lesson sequence and learning activities (15); EMI scaffolding, vocabulary, and language support (15); engagement, differentiation, and inclusion (10); assessment and checks for understanding (10); classroom management and STEM safety (10); feasibility and teacher reflection (5).",
    "Base every finding on evidence in the document. If required information is missing, identify it as an area to improve rather than inventing it.",
    "For every narrative field, write concise English first and then a Vietnamese translation, separated by ' / '.",
    teacherNotes
      ? `Teacher context: ${teacherNotes}`
      : "No additional teacher context was supplied.",
  ].join("\n\n");

  let {
    response: openAIResponse,
    payload,
  } = await requestEvaluation(
    apiKey,
    filePart.filename,
    fileData,
    extension,
    prompt
  );

  if (!openAIResponse.ok) {
    const errorMessage = upstreamError(payload);

    console.error(
      "OpenAI evaluation failed",
      openAIResponse.status,
      errorMessage
    );

    if (
      openAIResponse.status === 429 &&
      /no credits|insufficient_quota|quota|billing/i.test(errorMessage)
    ) {
      setResponseStatus(event, 503);
      return {
        error:
          "AI evaluation is unavailable because the site API account has no remaining credits. Please contact the site administrator.",
      };
    }

    setResponseStatus(event, 502);
    return {
      error:
        "The AI evaluation service is temporarily unavailable. Please try again.",
    };
  }

  let outputText = getOutputText(payload);

  if (!outputText) {
    setResponseStatus(event, 502);
    return {
      error:
        "The evaluator did not return a report. Please try again.",
    };
  }

  let evaluation = parseEvaluation(outputText);

  if (!evaluation) {
    const retryPrompt = [
      prompt,
      "Return one complete JSON report. Keep every bilingual evidence, recommendation, and rationale concise so the entire report fits within the response limit.",
    ].join("\n\n");

    ({
      response: openAIResponse,
      payload,
    } = await requestEvaluation(
      apiKey,
      filePart.filename,
      fileData,
      extension,
      retryPrompt
    ));

    if (!openAIResponse.ok) {
      setResponseStatus(event, 502);
      return {
        error:
          "The AI evaluation service is temporarily unavailable. Please try again.",
      };
    }

    outputText = getOutputText(payload);
    evaluation = parseEvaluation(outputText);
  }

  if (!evaluation) {
    setResponseStatus(event, 502);
    return {
      error:
        "The evaluation report could not be read. Please try again.",
    };
  }

  return {
    evaluation,
  };
});
