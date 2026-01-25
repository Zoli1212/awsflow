"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getStatistics, getUserActivityDetails, updateUserRole, UserStatistics, UserRoleType } from "@/actions/statistics-actions";
import { toast } from "sonner";
import { ChevronLeft, Users, Crown, Building2, HardHat, Eye, X } from "lucide-react";

interface ActivityDetails {
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
}

export default function StatisticsPage() {
  const router = useRouter();
  const [users, setUsers] = useState<UserStatistics[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState("");
  const [stats, setStats] = useState({
    totalUsers: 0,
    totalSuperUsers: 0,
    totalTenants: 0,
    totalWorkers: 0,
  });
  const [selectedUser, setSelectedUser] = useState<UserStatistics | null>(null);
  const [activityDetails, setActivityDetails] = useState<ActivityDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [updatingRoleId, setUpdatingRoleId] = useState<number | null>(null);

  useEffect(() => {
    const loadData = async () => {
      try {
        setIsLoading(true);
        const result = await getStatistics();

        if (result.success && result.data) {
          setUsers(result.data.users);
          setStats({
            totalUsers: result.data.totalUsers,
            totalSuperUsers: result.data.totalSuperUsers,
            totalTenants: result.data.totalTenants,
            totalWorkers: result.data.totalWorkers,
          });
        } else {
          toast.error(result.error || "Hiba a statisztikák betöltésekor");
          router.push("/works");
        }
      } catch (error) {
        console.error("Hiba a statisztikák betöltésekor:", error);
        toast.error("Hiba a statisztikák betöltésekor");
        router.push("/works");
      } finally {
        setIsLoading(false);
      }
    };

    loadData();
  }, [router]);

  const handleViewDetails = async (user: UserStatistics) => {
    setSelectedUser(user);
    setLoadingDetails(true);

    try {
      const result = await getUserActivityDetails(user.email);
      if (result.success && result.data) {
        setActivityDetails(result.data);
      } else {
        toast.error(result.error || "Hiba az aktivitás betöltésekor");
      }
    } catch (error) {
      console.error("Error loading activity details:", error);
      toast.error("Hiba az aktivitás betöltésekor");
    } finally {
      setLoadingDetails(false);
    }
  };

  const getUserRoleType = (user: UserStatistics): UserRoleType => {
    if (user.isSuperUser) return "superuser";
    if (user.isTenant) return "tenant";
    return "worker";
  };

  const handleRoleChange = async (userId: number, newRole: UserRoleType) => {
    setUpdatingRoleId(userId);
    try {
      const result = await updateUserRole(userId, newRole);
      if (result.success) {
        // Update local state
        setUsers((prevUsers) =>
          prevUsers.map((u) => {
            if (u.id === userId) {
              return {
                ...u,
                isSuperUser: newRole === "superuser",
                isTenant: newRole === "superuser" || newRole === "tenant",
              };
            }
            return u;
          })
        );
        // Update stats
        const updatedUsers = users.map((u) => {
          if (u.id === userId) {
            return {
              ...u,
              isSuperUser: newRole === "superuser",
              isTenant: newRole === "superuser" || newRole === "tenant",
            };
          }
          return u;
        });
        setStats({
          totalUsers: updatedUsers.length,
          totalSuperUsers: updatedUsers.filter((u) => u.isSuperUser).length,
          totalTenants: updatedUsers.filter((u) => u.isTenant).length,
          totalWorkers: updatedUsers.filter((u) => !u.isTenant).length,
        });
        toast.success("Szerepkör sikeresen módosítva");
      } else {
        toast.error(result.error || "Hiba a szerepkör módosításakor");
      }
    } catch (error) {
      console.error("Error updating role:", error);
      toast.error("Hiba a szerepkör módosításakor");
    } finally {
      setUpdatingRoleId(null);
    }
  };

  const filteredUsers = users.filter(
    (user) =>
      user.name
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .includes(
          searchTerm
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
        ) ||
      user.email
        .toLowerCase()
        .includes(searchTerm.toLowerCase())
  );

  const formatDate = (date: Date | string | undefined | null) => {
    if (!date) return "-";
    const d = new Date(date);
    return d.toLocaleDateString("hu-HU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const getRoleBadge = (user: UserStatistics) => {
    if (user.isSuperUser) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
          <Crown className="w-3 h-3" />
          SuperUser
        </span>
      );
    }
    if (user.isTenant) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
          <Building2 className="w-3 h-3" />
          Tenant
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
        <HardHat className="w-3 h-3" />
        Worker
      </span>
    );
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-lg text-gray-600">Statisztikák betöltése...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-3 md:p-6">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <button
            onClick={() => router.push("/works")}
            className="p-2 hover:bg-gray-100 rounded-full transition-colors"
            title="Vissza"
          >
            <ChevronLeft className="h-6 w-6" style={{ color: "#FE9C00" }} />
          </button>
          <h1 className="text-2xl md:text-3xl font-bold text-gray-900">
            Statisztika
          </h1>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-orange-100">
                <Users className="h-6 w-6" style={{ color: "#FE9C00" }} />
              </div>
              <div>
                <p className="text-sm text-gray-500">Összes user</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalUsers}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-purple-100">
                <Crown className="h-6 w-6 text-purple-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">SuperUser</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalSuperUsers}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-blue-100">
                <Building2 className="h-6 w-6 text-blue-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Tenant</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalTenants}</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-full bg-gray-100">
                <HardHat className="h-6 w-6 text-gray-600" />
              </div>
              <div>
                <p className="text-sm text-gray-500">Worker</p>
                <p className="text-2xl font-bold text-gray-900">{stats.totalWorkers}</p>
              </div>
            </div>
          </div>
        </div>

        {/* Search Input */}
        <div className="mb-6">
          <input
            type="text"
            placeholder="Keresés név vagy email alapján..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-500 focus:border-transparent"
          />
        </div>

        {/* Users Table - Desktop */}
        <div className="hidden md:block bg-white rounded-lg shadow overflow-hidden">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                    Név
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                    Email
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                    Típus
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                    Regisztráció
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                    Utolsó aktivitás
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-700 uppercase">
                    Aktivitás
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-700 uppercase">
                    Meghívó
                  </th>
                  <th className="px-6 py-3 text-center text-xs font-medium text-gray-700 uppercase">
                    Részletek
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-4 text-center text-gray-500">
                      {searchTerm ? "Nincs találat" : "Nincsenek felhasználók"}
                    </td>
                  </tr>
                ) : (
                  filteredUsers.map((user) => (
                    <tr key={user.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 text-sm font-medium text-gray-900">
                        {user.name || "-"}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {user.email}
                      </td>
                      <td className="px-6 py-4 text-sm">
                        <select
                          value={getUserRoleType(user)}
                          onChange={(e) => handleRoleChange(user.id, e.target.value as UserRoleType)}
                          disabled={updatingRoleId === user.id}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium border-2 cursor-pointer focus:outline-none focus:ring-2 focus:ring-orange-400 transition-all ${
                            updatingRoleId === user.id ? "opacity-50" : ""
                          }`}
                          style={{
                            borderColor: "#FE9C00",
                            backgroundColor: user.isSuperUser ? "#FFF7ED" : user.isTenant ? "#FFF7ED" : "#F9FAFB",
                            color: "#EA580C",
                          }}
                        >
                          <option value="superuser">SuperUser</option>
                          <option value="tenant">Tenant</option>
                          <option value="worker">Worker</option>
                        </select>
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {formatDate(user.createdAt)}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {formatDate(user.lastActivity)}
                      </td>
                      <td className="px-6 py-4 text-sm text-center text-gray-900 font-medium">
                        {user.activityCount}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-600">
                        {user.invitedBy || "-"}
                      </td>
                      <td className="px-6 py-4 text-center">
                        <button
                          onClick={() => handleViewDetails(user)}
                          className="p-1.5 rounded-md hover:bg-orange-50 transition-colors"
                          style={{ color: "#FE9C00" }}
                          title="Részletek"
                        >
                          <Eye className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Users Cards - Mobile */}
        <div className="md:hidden space-y-3">
          {filteredUsers.length === 0 ? (
            <div className="bg-white rounded-lg p-4 text-center text-gray-500">
              {searchTerm ? "Nincs találat" : "Nincsenek felhasználók"}
            </div>
          ) : (
            filteredUsers.map((user) => (
              <div
                key={user.id}
                className="bg-white rounded-lg shadow-sm border border-gray-200 p-4"
              >
                <div className="flex justify-between items-start mb-3">
                  <div className="flex-1">
                    <h3 className="font-semibold text-gray-900 text-base">
                      {user.name || "-"}
                    </h3>
                    <p className="text-sm text-gray-500">{user.email}</p>
                  </div>
                  <button
                    onClick={() => handleViewDetails(user)}
                    className="p-1.5 rounded-md hover:bg-orange-50 transition-colors"
                    style={{ color: "#FE9C00" }}
                    title="Részletek"
                  >
                    <Eye className="h-5 w-5" />
                  </button>
                </div>

                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Regisztráció:</span>
                    <span className="text-gray-700">{formatDate(user.createdAt)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Utolsó aktivitás:</span>
                    <span className="text-gray-700">{formatDate(user.lastActivity)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Aktivitás:</span>
                    <span className="text-gray-700 font-medium">{user.activityCount}</span>
                  </div>
                  {user.invitedBy && (
                    <div className="flex justify-between">
                      <span className="text-gray-500">Meghívó:</span>
                      <span className="text-gray-700">{user.invitedBy}</span>
                    </div>
                  )}
                </div>

                <div className="mt-3 pt-3 border-t border-gray-200">
                  <select
                    value={getUserRoleType(user)}
                    onChange={(e) => handleRoleChange(user.id, e.target.value as UserRoleType)}
                    disabled={updatingRoleId === user.id}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border-2 cursor-pointer focus:outline-none focus:ring-2 focus:ring-orange-400 transition-all ${
                      updatingRoleId === user.id ? "opacity-50" : ""
                    }`}
                    style={{
                      borderColor: "#FE9C00",
                      backgroundColor: "#FFF7ED",
                      color: "#EA580C",
                    }}
                  >
                    <option value="superuser">SuperUser</option>
                    <option value="tenant">Tenant</option>
                    <option value="worker">Worker</option>
                  </select>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* User Details Modal */}
      {selectedUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
            <div className="sticky top-0 bg-white border-b border-gray-200 p-4 flex justify-between items-center">
              <h3 className="text-lg font-semibold text-gray-900">
                {selectedUser.name || selectedUser.email}
              </h3>
              <button
                onClick={() => {
                  setSelectedUser(null);
                  setActivityDetails(null);
                }}
                className="p-1.5 rounded-md hover:bg-gray-100 transition-colors"
              >
                <X className="h-5 w-5 text-gray-500" />
              </button>
            </div>

            <div className="p-4">
              {/* User Info */}
              <div className="mb-6">
                <h4 className="font-medium text-gray-900 mb-3">Felhasználó adatai</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <span className="text-gray-500">Email:</span>
                    <p className="font-medium">{selectedUser.email}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Típus:</span>
                    <div className="mt-1">{getRoleBadge(selectedUser)}</div>
                  </div>
                  <div>
                    <span className="text-gray-500">Regisztráció:</span>
                    <p className="font-medium">{formatDate(selectedUser.createdAt)}</p>
                  </div>
                  <div>
                    <span className="text-gray-500">Utolsó aktivitás:</span>
                    <p className="font-medium">{formatDate(selectedUser.lastActivity)}</p>
                  </div>
                  {selectedUser.invitedBy && (
                    <div>
                      <span className="text-gray-500">Meghívó:</span>
                      <p className="font-medium">{selectedUser.invitedBy}</p>
                    </div>
                  )}
                  {selectedUser.trialEndsAt && (
                    <div>
                      <span className="text-gray-500">Trial lejárat:</span>
                      <p className="font-medium">{formatDate(selectedUser.trialEndsAt)}</p>
                    </div>
                  )}
                </div>
              </div>

              {loadingDetails ? (
                <div className="text-center py-8 text-gray-500">
                  Betöltés...
                </div>
              ) : activityDetails ? (
                <>
                  {/* Activity Summary */}
                  <div className="mb-6">
                    <h4 className="font-medium text-gray-900 mb-3">Aktivitás összesítés</h4>
                    <div className="grid grid-cols-3 gap-3">
                      <div className="bg-gray-50 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold" style={{ color: "#FE9C00" }}>
                          {activityDetails.offersCount}
                        </p>
                        <p className="text-xs text-gray-500">Ajánlat</p>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold" style={{ color: "#FE9C00" }}>
                          {activityDetails.worksCount}
                        </p>
                        <p className="text-xs text-gray-500">Munka</p>
                      </div>
                      <div className="bg-gray-50 rounded-lg p-3 text-center">
                        <p className="text-2xl font-bold" style={{ color: "#FE9C00" }}>
                          {activityDetails.billingsCount}
                        </p>
                        <p className="text-xs text-gray-500">Számla</p>
                      </div>
                    </div>
                  </div>

                  {/* Recent Activity */}
                  <div>
                    <h4 className="font-medium text-gray-900 mb-3">Utolsó aktivitások</h4>
                    {activityDetails.recentActivity.length === 0 ? (
                      <p className="text-gray-500 text-sm">Nincs rögzített aktivitás</p>
                    ) : (
                      <div className="space-y-2 max-h-60 overflow-y-auto">
                        {activityDetails.recentActivity.map((activity) => (
                          <div
                            key={activity.id}
                            className="bg-gray-50 rounded-lg p-3 text-sm"
                          >
                            <div className="flex justify-between items-start">
                              <div className="flex-1">
                                {activity.aiAgentType && (
                                  <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800 mb-1">
                                    {activity.aiAgentType}
                                  </span>
                                )}
                                {activity.fileName && (
                                  <p className="text-gray-700 font-medium">
                                    {activity.fileName}
                                  </p>
                                )}
                                {activity.fileType && (
                                  <p className="text-gray-500 text-xs">
                                    Típus: {activity.fileType}
                                  </p>
                                )}
                              </div>
                              <span className="text-xs text-gray-400">
                                {activity.createdAt || "-"}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : null}
            </div>

            <div className="sticky bottom-0 bg-white border-t border-gray-200 p-4">
              <button
                onClick={() => {
                  setSelectedUser(null);
                  setActivityDetails(null);
                }}
                className="w-full px-4 py-2 text-white rounded-md transition-colors"
                style={{ backgroundColor: "#FE9C00" }}
              >
                Bezárás
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
