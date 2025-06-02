"use server";

import { serializeCarData } from "@/lib/helpers";
import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

// ---- Shared Helpers ----
async function requireAdmin() {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user || user.role !== "ADMIN") throw new Error("Unauthorized access");

  return user;
}

// ---- Admin Check ----
export async function getAdmin() {
  try {
    const user = await requireAdmin();
    return { authorized: true, user };
  } catch {
    return { authorized: false, reason: "not-admin" };
  }
}

// ---- Get Test Drives ----
export async function getAdminTestDrives({ search = "", status = "" }) {
  try {
    await requireAdmin();

    // Build filters
    let where: any = {};

    if (status) {
      where.AND = [{ status }];
    }

    if (search) {
      const searchCondition = {
        OR: [
          {
            car: {
              OR: [
                { make: { contains: search, mode: "insensitive" } },
                { model: { contains: search, mode: "insensitive" } },
              ],
            },
          },
          {
            user: {
              OR: [
                { name: { contains: search, mode: "insensitive" } },
                { email: { contains: search, mode: "insensitive" } },
              ],
            },
          },
        ],
      };
      where.AND = [...(where.AND || []), searchCondition];
    }

    const bookings = await db.testDriveBooking.findMany({
      where,
      include: {
        car: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            imageUrl: true,
            phone: true,
          },
        },
      },
      orderBy: [{ bookingDate: "desc" }, { startTime: "asc" }],
    });

    const formatted = bookings.map((b) => ({
      id: b.id,
      carId: b.carId,
      car: serializeCarData(b.car),
      userId: b.userId,
      user: b.user,
      bookingDate: b.bookingDate.toISOString(),
      startTime: b.startTime,
      endTime: b.endTime,
      status: b.status,
      notes: b.notes,
      createdAt: b.createdAt.toISOString(),
      updatedAt: b.updatedAt.toISOString(),
    }));

    return { success: true, data: formatted };
  } catch (error: any) {
    console.error("Error fetching test drives:", error);
    return { success: false, error: error.message };
  }
}

// ---- Update Test Drive ----
export async function updateTestDriveStatus(bookingId: string, newStatus: string) {
  try {
    await requireAdmin();

    const booking = await db.testDriveBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      return { success: false, error: "Booking not found" };
    }

    const validStatuses = ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"];
    if (!validStatuses.includes(newStatus)) {
      return { success: false, error: "Invalid status" };
    }

    await db.testDriveBooking.update({
      where: { id: bookingId },
      data: { status: newStatus },
    });

    revalidatePath("/admin/test-drives");
    revalidatePath("/reservations");

    return { success: true, message: "Test drive status updated successfully" };
  } catch (error: any) {
    console.error("Error updating test drive:", error);
    return { success: false, error: error.message };
  }
}

// ---- Dashboard ----
export async function getDashboardData() {
  try {
    await requireAdmin();

    // Aggregate queries
    const [cars, testDrives] = await Promise.all([
      db.car.findMany({ select: { id: true, status: true, featured: true } }),
      db.testDriveBooking.findMany({ select: { id: true, status: true, carId: true } }),
    ]);

    // Car stats
    const totalCars = cars.length;
    const availableCars = cars.filter((c) => c.status === "AVAILABLE").length;
    const soldCars = cars.filter((c) => c.status === "SOLD").length;
    const unavailableCars = cars.filter((c) => c.status === "UNAVAILABLE").length;
    const featuredCars = cars.filter((c) => c.featured).length;

    // Test drive stats
    const totalTestDrives = testDrives.length;
    const pending = testDrives.filter((td) => td.status === "PENDING").length;
    const confirmed = testDrives.filter((td) => td.status === "CONFIRMED").length;
    const completed = testDrives.filter((td) => td.status === "COMPLETED").length;
    const cancelled = testDrives.filter((td) => td.status === "CANCELLED").length;
    const noShow = testDrives.filter((td) => td.status === "NO_SHOW").length;

    // Conversion rate
    const completedCarIds = new Set(
      testDrives.filter((td) => td.status === "COMPLETED").map((td) => td.carId)
    );
    const soldAfterTestDrive = cars.filter(
      (c) => c.status === "SOLD" && completedCarIds.has(c.id)
    ).length;
    const conversionRate = completed > 0 ? (soldAfterTestDrive / completed) * 100 : 0;

    return {
      success: true,
      data: {
        cars: {
          total: totalCars,
          available: availableCars,
          sold: soldCars,
          unavailable: unavailableCars,
          featured: featuredCars,
        },
        testDrives: {
          total: totalTestDrives,
          pending,
          confirmed,
          completed,
          cancelled,
          noShow,
          conversionRate: parseFloat(conversionRate.toFixed(2)),
        },
      },
    };
  } catch (error: any) {
    console.error("Error fetching dashboard data:", error);
    return { success: false, error: error.message };
  }
}
