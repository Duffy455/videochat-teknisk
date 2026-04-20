const form = document.querySelector("[data-admin-join-form]");

form?.addEventListener("submit", (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const room = String(formData.get("room") || "default-room").trim() || "default-room";
  const nextUrl = new URL("./video-admin.html", window.location.href);
  nextUrl.searchParams.set("room", room);
  window.location.href = nextUrl.toString();
});
