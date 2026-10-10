import { Form, useNavigation } from "react-router";
import type { Route } from "./+types/home";

export function meta({}: Route.MetaArgs) {
  return [{ title: "DischargeAI" }];
}

export async function loader() {
  const backend = process.env.BACKEND_URL ?? "http://localhost:3000";
  const res = await fetch(`${backend}/api/patients`);
  if (!res.ok) {
    throw new Response("Failed to load patients", { status: res.status });
  }
  return (await res.json()) as Record<string, unknown>[];
}

export async function clientAction() {
  const res = await fetch("/api/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: "asdfjhadsgkfbadf", type: "text" }),
  });
  const result = await res.json().catch(() => null);
  return { ok: res.ok, message: result?.message ?? res.statusText };
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";
  const columns = loaderData.length ? Object.keys(loaderData[0]) : [];

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="mb-4 text-2xl font-bold">Patients</h1>

      <Form method="post" className="mb-6">
        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
        >
          {submitting ? "Ingesting..." : "Ingest"}
        </button>
        {actionData && (
          <span
            className={`ml-3 ${actionData.ok ? "text-green-600" : "text-red-600"}`}
          >
            {actionData.message}
          </span>
        )}
      </Form>

      {loaderData.length === 0 ? (
        <p>No patients found.</p>
      ) : (
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c} className="border-b p-2">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loaderData.map((row, i) => (
              <tr key={i}>
                {columns.map((c) => (
                  <td key={c} className="border-b p-2">
                    {String(row[c] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
