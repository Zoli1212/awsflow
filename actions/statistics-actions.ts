"use server";

import { currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/prisma";

export interface UserStatistics {
  id: number;
  name: string;
  email: string;
  role: string;
  isSuperUser: boolean;
  isTenant: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastActivity?: Date;
  activityCount: number;
  invitedBy?: string | null;
  trialEndsAt?: Date | null;
}

export interface StatisticsData {
  users: UserStatistics[];
  totalUsers: number;
  totalSuperUsers: number;
  totalTenants: number;
  totalWorkers: number;
}

export async function getStatistics(): Promise<{
  success: boolean;
  data?: StatisticsData;
  error?: string;
}> {
  try {
    const user = await currentUser();

    if (!user || !user.emailAddresses?.[0]?.emailAddress) {
      return {
        success: false,
        error: "Unauthorized",
      };
    }

    const email = user.emailAddresses[0].emailAddress;

    // Check if current user is superuser
    const currentUserData = await prisma.user.findUnique({
      where: { email },
      select: { isSuperUser: true },
    });

    if (!currentUserData?.isSuperUser) {
      return {
        success: false,
        error: "Nincs jogosultságod a statisztikák megtekintéséhez",
      };
    }

    // Get all users
    const users = await prisma.user.findMany({
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isSuperUser: true,
        isTenant: true,
        createdAt: true,
        updatedAt: true,
        invitedBy: true,
        trialEndsAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    // Get activity counts from History table for each user
    const usersWithActivity = await Promise.all(
      users.map(async (u) => {
        const historyCount = await prisma.history.count({
          where: {
            OR: [
              { userEmail: u.email },
              { tenantEmail: u.email },
            ],
          },
        });

        const lastHistory = await prisma.history.findFirst({
          where: {
            OR: [
              { userEmail: u.email },
              { tenantEmail: u.email },
            ],
          },
          orderBy: {
            createdAt: "desc",
          },
          select: {
            createdAt: true,
          },
        });

        return {
          ...u,
          activityCount: historyCount,
          lastActivity: lastHistory?.createdAt
            ? new Date(lastHistory.createdAt)
            : undefined,
        };
      })
    );

    const totalUsers = users.length;
    const totalSuperUsers = users.filter((u) => u.isSuperUser).length;
    const totalTenants = users.filter((u) => u.isTenant).length;
    const totalWorkers = users.filter((u) => !u.isTenant).length;

    return {
      success: true,
      data: {
        users: usersWithActivity,
        totalUsers,
        totalSuperUsers,
        totalTenants,
        totalWorkers,
      },
    };
  } catch (error) {
    console.error("Error fetching statistics:", error);
    return {
      success: false,
      error: (error as Error).message || "Hiba a statisztikák lekérésekor",
    };
  }
}

export type UserRoleType = "superuser" | "tenant" | "worker";

export async function updateUserRole(
  userId: number,
  roleType: UserRoleType
): Promise<{ success: boolean; error?: string }> {
  try {
    const user = await currentUser();

    if (!user || !user.emailAddresses?.[0]?.emailAddress) {
      return {
        success: false,
        error: "Unauthorized",
      };
    }

    const email = user.emailAddresses[0].emailAddress;

    // Check if current user is superuser
    const currentUserData = await prisma.user.findUnique({
      where: { email },
      select: { isSuperUser: true },
    });

    if (!currentUserData?.isSuperUser) {
      return {
        success: false,
        error: "Nincs jogosultságod a szerepkör módosításához",
      };
    }

    // Update user role based on roleType
    let updateData: { isSuperUser: boolean; isTenant: boolean };

    switch (roleType) {
      case "superuser":
        updateData = { isSuperUser: true, isTenant: true };
        break;
      case "tenant":
        updateData = { isSuperUser: false, isTenant: true };
        break;
      case "worker":
        updateData = { isSuperUser: false, isTenant: false };
        break;
      default:
        return {
          success: false,
          error: "Érvénytelen szerepkör",
        };
    }

    await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return { success: true };
  } catch (error) {
    console.error("Error updating user role:", error);
    return {
      success: false,
      error: (error as Error).message || "Hiba a szerepkör módosításakor",
    };
  }
}

export async function getUserActivityDetails(userEmail: string): Promise<{
  success: boolean;
  data?: {
    recentActivity: {
      id: number;
      content: unknown;
      createdAt: string | null;
      aiAgentType: string | null;
      fileType: string | null;
      fileName: string | null;
    }[];
    offersCount: number;
    worksCount: number;
    billingsCount: number;
  };
  error?: string;
}> {
  try {
    const user = await currentUser();

    if (!user || !user.emailAddresses?.[0]?.emailAddress) {
      return {
        success: false,
        error: "Unauthorized",
      };
    }

    const email = user.emailAddresses[0].emailAddress;

    // Check if current user is superuser
    const currentUserData = await prisma.user.findUnique({
      where: { email },
      select: { isSuperUser: true },
    });

    if (!currentUserData?.isSuperUser) {
      return {
        success: false,
        error: "Nincs jogosultságod",
      };
    }

    // Get recent activity from History
    const recentActivity = await prisma.history.findMany({
      where: {
        OR: [
          { userEmail: userEmail },
          { tenantEmail: userEmail },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
      select: {
        id: true,
        content: true,
        createdAt: true,
        aiAgentType: true,
        fileType: true,
        fileName: true,
      },
    });

    // Count offers, works, billings
    const offersCount = await prisma.offer.count({
      where: { tenantEmail: userEmail },
    });

    const worksCount = await prisma.work.count({
      where: { tenantEmail: userEmail },
    });

    const billingsCount = await prisma.billing.count({
      where: { tenantEmail: userEmail },
    });

    return {
      success: true,
      data: {
        recentActivity,
        offersCount,
        worksCount,
        billingsCount,
      },
    };
  } catch (error) {
    console.error("Error fetching user activity details:", error);
    return {
      success: false,
      error: (error as Error).message || "Hiba a felhasználó aktivitás lekérésekor",
    };
  }
}
