// src/core/supervisor.js

export async function route(message, organizationId, prisma) {
  try {
    // Keep this database check intact so your multi-tenant structure works
    const orgConfig = await prisma.organization.findUnique({
      where: { id: organizationId },
      include: { knowledgeBases: true }
    });

    // Check what the customer said
    const customerText = (message || "").toLowerCase().trim();

    // Custom response logic
    if (customerText === "hi" || customerText === "hello") {
      return { text: "Hi, I am AI" };
    }

    // Default response for other messages
    return { text: "Welcome! Your custom response platform is active." };

  } catch (error) {
    console.error("Supervisor routing error:", error);
    return { text: "Sorry, an internal routing error occurred." };
  }
}
