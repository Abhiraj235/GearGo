"use server";

import { serializeCarData } from "@/lib/helpers";
import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

// Helper: get database user from Clerk ID
async function getDbUser() {
  const { userId } = await auth();
  if (!userId) return null;
  return db.user.findUnique({ where: { clerkUserId: userId } });
}

/**
 * Get simplified filters for the car marketplace
 */
export async function getCarFilters() {
  try {
    const [makes, bodyTypes, fuelTypes, transmissions, priceAggregations] =
      await Promise.all([
        db.car.findMany({
          where: { status: "AVAILABLE" },
          select: { make: true },
          distinct: ["make"],
          orderBy: { make: "asc" },
        }),
        db.car.findMany({
          where: { status: "AVAILABLE" },
          select: { bodyType: true },
          distinct: ["bodyType"],
          orderBy: { bodyType: "asc" },
        }),
        db.car.findMany({
          where: { status: "AVAILABLE" },
          select: { fuelType: true },
          distinct: ["fuelType"],
          orderBy: { fuelType: "asc" },
        }),
        db.car.findMany({
          where: { status: "AVAILABLE" },
          select: { transmission: true },
          distinct: ["transmission"],
          orderBy: { transmission: "asc" },
        }),
        db.car.aggregate({
          where: { status: "AVAILABLE" },
          _min: { price: true },
          _max: { price: true },
        }),
      ]);

    return {
      success: true,
      data: {
        makes: makes.map((i) => i.make?.toLowerCase()),
        bodyTypes: bodyTypes.map((i) => i.bodyType?.toLowerCase()),
        fuelTypes: fuelTypes.map((i) => i.fuelType?.toLowerCase()),
        transmissions: transmissions.map((i) => i.transmission?.toLowerCase()),
        priceRange: {
          min: priceAggregations._min.price
            ? parseFloat(priceAggregations._min.price.toString())
            : 0,
          max: priceAggregations._max.price
            ? parseFloat(priceAggregations._max.price.toString())
            : 100000,
        },
      },
      error: null,
    };
  } catch (error) {
    return { success: false, data: null, error: "Failed to fetch filters" };
  }
}

export async function getCars({
  search = "",
  make = "",
  bodyType = "",
  fuelType = "",
  transmission = "",
  minPrice = 0,
  maxPrice = Number.MAX_SAFE_INTEGER,
  sortBy = "newest", // Options: newest, priceAsc, priceDesc
  page = 1,
  limit = 6,
}) {
  try {
    const dbUser = await getDbUser();

    // Build where conditions
    let where = { status: "AVAILABLE" };

    if (search) {
      where.OR = [
        { make: { contains: search, mode: "insensitive" } },
        { model: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    if (make) where.make = { equals: make, mode: "insensitive" };
    if (bodyType) where.bodyType = { equals: bodyType, mode: "insensitive" };
    if (fuelType) where.fuelType = { equals: fuelType, mode: "insensitive" };
    if (transmission)
      where.transmission = { equals: transmission, mode: "insensitive" };
    where.price = { gte: parseFloat(minPrice) || 0 };

    if (maxPrice && maxPrice < Number.MAX_SAFE_INTEGER) {
      where.price.lte = parseFloat(maxPrice);
    }

    // Pagination
    const skip = (page - 1) * limit;

    // Sort order
    let orderBy = {};
    switch (sortBy) {
      case "priceAsc":
        orderBy = { price: "asc" };
        break;
      case "priceDesc":
        orderBy = { price: "desc" };
        break;
      case "newest":
      default:
        orderBy = { createdAt: "desc" };
        break;
    }

    const [totalCars, cars] = await Promise.all([
      db.car.count({ where }),
      db.car.findMany({ where, take: limit, skip, orderBy }),
    ]);

    // Wishlist check
    let wishlisted = new Set();
    if (dbUser) {
      const savedCars = await db.userSavedCar.findMany({
        where: { userId: dbUser.id },
        select: { carId: true },
      });
      wishlisted = new Set(savedCars.map((s) => s.carId));
    }

    const serializedCars = cars.map((car) =>
      serializeCarData(car, wishlisted.has(car.id))
    );

    return {
      success: true,
      data: serializedCars,
      pagination: {
        total: totalCars,
        page,
        limit,
        pages: limit > 0 ? Math.ceil(totalCars / limit) : 0,
      },
      error: null,
    };
  } catch (error) {
    return { success: false, data: null, error: "Failed to fetch cars" };
  }
}

/**
 * Toggle car in user's wishlist
 */
export async function toggleSavedCar(carId) {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) return { success: false, data: null, error: "Unauthorized" };

    const car = await db.car.findUnique({ where: { id: carId } });
    if (!car) return { success: false, data: null, error: "Car not found" };

    const existingSave = await db.userSavedCar.findUnique({
      where: { userId_carId: { userId: dbUser.id, carId } },
    });

    if (existingSave) {
      await db.userSavedCar.delete({
        where: { userId_carId: { userId: dbUser.id, carId } },
      });
      revalidatePath(`/saved-cars`);
      revalidatePath(`/car/${carId}`);
      return { success: true, data: { saved: false }, error: null };
    }

    await db.userSavedCar.create({ data: { userId: dbUser.id, carId } });
    revalidatePath(`/saved-cars`);
    revalidatePath(`/car/${carId}`);
    return { success: true, data: { saved: true }, error: null };
  } catch (error) {
    return { success: false, data: null, error: "Failed to toggle saved car" };
  }
}

/**
 * Get car details by ID
 */
export async function getCarById(carId) {
  try {
    const dbUser = await getDbUser();

    const car = await db.car.findUnique({ where: { id: carId } });
    if (!car) return { success: false, data: null, error: "Car not found" };

    // Wishlist status
    let isWishlisted = false;
    if (dbUser) {
      const savedCar = await db.userSavedCar.findUnique({
        where: { userId_carId: { userId: dbUser.id, carId } },
      });
      isWishlisted = !!savedCar;
    }

    // User test drive info
    let userTestDrive = null;
    if (dbUser) {
      const existingTestDrive = await db.testDriveBooking.findFirst({
        where: {
          carId,
          userId: dbUser.id,
          status: { in: ["PENDING", "CONFIRMED", "COMPLETED"] },
        },
        orderBy: { createdAt: "desc" },
      });
      if (existingTestDrive) {
        userTestDrive = {
          id: existingTestDrive.id,
          status: existingTestDrive.status,
          bookingDate: existingTestDrive.bookingDate.toISOString(),
        };
      }
    }

    const dealership = await db.dealershipInfo.findFirst({
      include: { workingHours: true },
    });

    return {
      success: true,
      data: {
        ...serializeCarData(car, isWishlisted),
        testDriveInfo: {
          userTestDrive,
          dealership: dealership
            ? {
                ...dealership,
                createdAt: dealership.createdAt.toISOString(),
                updatedAt: dealership.updatedAt.toISOString(),
                workingHours: dealership.workingHours.map((h) => ({
                  ...h,
                  createdAt: h.createdAt.toISOString(),
                  updatedAt: h.updatedAt.toISOString(),
                })),
              }
            : null,
        },
      },
      error: null,
    };
  } catch (error) {
    return { success: false, data: null, error: "Failed to fetch car details" };
  }
}

/**
 * Get user's saved cars
 */
export async function getSavedCars() {
  try {
    const dbUser = await getDbUser();
    if (!dbUser) return { success: false, data: null, error: "Unauthorized" };

    const savedCars = await db.userSavedCar.findMany({
      where: { userId: dbUser.id },
      include: { car: true },
      orderBy: { savedAt: "desc" },
    });

    const cars = savedCars.map((s) => serializeCarData(s.car));

    return { success: true, data: cars, error: null };
  } catch (error) {
    return { success: false, data: null, error: "Failed to fetch saved cars" };
  }
}
