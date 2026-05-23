export default (request: Request) => {
  return new Response(
    JSON.stringify({ relay: "ok", url: request.url, method: request.method }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};
