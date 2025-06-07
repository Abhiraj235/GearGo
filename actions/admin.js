"use server";

import { serializeCarData } from "@/lib/helpers";
import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

// Helper: get admin user
async function getDbAdmin() {
  const { userId } = await auth();
  if (!userId) return null;

  const user = await db.user.findUnique({ where: { clerkUserId: userId } });
  if (!user || user.role !== "ADMIN") return null;

  return user;
}

export async function getAdmin() {
  try {
    const admin = await getDbAdmin();
    if (!admin) {
      return { success: true, data: { authorized: false, reason: "not-admin" }, error: null };
    }

    return { success: true, data: { authorized: true, user: admin }, error: null };
  } catch (error) {
    return { success: false, data: null, error: "Failed to check admin" };
  }
}

/**
 * Get all test drives for admin with filters
 */
export async function getAdminTestDrives({ search = "", status = "" }) {
  try {
    const admin = await getDbAdmin();
    if (!admin) return { success: false, data: null, error: "Unauthorized" };

    let where = {};
    if (status) where.status = status;

    if (search) {
      where.OR = [
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
      ];
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

    return { success: true, data: formatted, error: null };
  } catch (error) {
    return { success: false, data: null, error: "Failed to fetch test drives" };
  }
}

/**
 * Update test drive status
 */
export async function updateTestDriveStatus(bookingId, newStatus) {
  try {
    const admin = await getDbAdmin();
    if (!admin) return { success: false, data: null, error: "Unauthorized" };

    const booking = await db.testDriveBooking.findUnique({ where: { id: bookingId } });
    if (!booking) return { success: false, data: null, error: "Booking not found" };

    const validStatuses = ["PENDING", "CONFIRMED", "COMPLETED", "CANCELLED", "NO_SHOW"];
    if (!validStatuses.includes(newStatus)) {
      return { success: false, data: null, error: "Invalid status" };
    }

    await db.testDriveBooking.update({
      where: { id: bookingId },
      data: { status: newStatus },
    });

    revalidatePath("/admin/test-drives");
    revalidatePath("/reservations");

    return { success: true, data: { message: "Status updated" }, error: null };
  } catch (error) {
    return { success: false, data: null, error: "Failed to update test drive status" };
  }
}

/**
 * Get dashboard statistics
 */
export async function getDashboardData() {
  try {
    const admin = await getDbAdmin();
    if (!admin) return { success: false, data: null, error: "Unauthorized" };

    const [cars, testDrives] = await Promise.all([
      db.car.findMany({
        select: { id: true, status: true, featured: true },
      }),
      db.testDriveBooking.findMany({
        select: { id: true, status: true, carId: true },
      }),
    ]);

    // Car stats
    const totalCars = cars.length;
    const available = cars.filter((c) => c.status === "AVAILABLE").length;
    const sold = cars.filter((c) => c.status === "SOLD").length;
    const unavailable = cars.filter((c) => c.status === "UNAVAILABLE").length;
    const featured = cars.filter((c) => c.featured).length;

    // Test drive stats
    const totalTD = testDrives.length;
    const pending = testDrives.filter((td) => td.status === "PENDING").length;
    const confirmed = testDrives.filter((td) => td.status === "CONFIRMED").length;
    const completed = testDrives.filter((td) => td.status === "COMPLETED").length;
    const cancelled = testDrives.filter((td) => td.status === "CANCELLED").length;
    const noShow = testDrives.filter((td) => td.status === "NO_SHOW").length;

    const completedCarIds = testDrives.filter((td) => td.status === "COMPLETED").map((td) => td.carId);
    const soldAfterTD = cars.filter((c) => c.status === "SOLD" && completedCarIds.includes(c.id)).length;

    const conversionRate = completed > 0 ? (soldAfterTD / completed) * 100 : 0;

    return {
      success: true,
      data: {
        cars: { total: totalCars, available, sold, unavailable, featured },
        testDrives: {
          total: totalTD,
          pending,
          confirmed,
          completed,
          cancelled,
          noShow,
          conversionRate: parseFloat(conversionRate.toFixed(2)),
        },
      },
      error: null,
    };
  } catch (error) {
    return { success: false, data: null, error: "Failed to fetch dashboard data" };
  }
}
