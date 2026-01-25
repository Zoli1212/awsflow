"use client";
// Új stílusos AppSidebar arany-sötétszürke témában

import React, { useEffect, useState, useRef } from "react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
} from "@/components/ui/sidebar";
import {
  Inbox,
  Layers,
  Palette,
  X,
  UserCircle,
  Wallet,
  Users,
  Sparkles,
  UserPlus,
  Check,
  DollarSign,
  BarChart3,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, useUser, useClerk } from "@clerk/nextjs";
import { useThemeStore } from "@/store/theme-store";
import { TenantSelectorSidebar } from "@/components/TenantSelectorSidebar";
import { getCurrentUserData } from "@/actions/user-actions";
import { useUserStore } from "@/store/userStore";
import { getUserSubscription } from "@/actions/subscription-actions";
import { generateInviteLink } from "@/actions/invite-actions";

const mainItems = [
  { title: "Munkáim", url: "/works", icon: Layers },
  { title: "Ajánlataim", url: "/offers", icon: Inbox, tenantOnly: true },
  { title: "Számláim", url: "/billings", icon: Wallet, tenantOnly: true },
  { title: "Munkások", url: "/others", icon: Users, tenantOnly: true },
  { title: "Áraim", url: "/prices", icon: DollarSign, tenantOnly: true },
  { title: "Statisztika", url: "/statistics", icon: BarChart3, superUserOnly: true },
];

const secondaryItems = [
  { title: "Előfizetésem", url: "/billing", icon: Wallet },
  { title: "Profil", url: "/profile", icon: UserCircle },
];

export function AppSidebar() {
  const path = usePathname();
  const { user } = useUser();
  const { signOut } = useClerk();
  const { theme: currentTheme, setTheme } = useThemeStore();
  const [showThemeSelector, setShowThemeSelector] = useState(false);
  const { isTenant, setUserData, clearUserData } = useUserStore();
  const [subscriptionPlan, setSubscriptionPlan] = useState<string | null>(null);
  const [isSuperUser, setIsSuperUser] = useState(false);
  const [isSuperUserLoading, setIsSuperUserLoading] = useState(true);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [inviteLinkDialog, setInviteLinkDialog] = useState<string | null>(null);
  const hasLoadedUserData = useRef(false);

  useEffect(() => {
    if (user?.id) {
      useThemeStore.getState().syncThemeWithDb(user.id);
    }
  }, [user]);

  useEffect(() => {
    const userEmail = user?.emailAddresses?.[0]?.emailAddress;

    // KRITIKUS: Ha nincs bejelentkezve, AZONNAL töröljük a cache-t
    if (!userEmail) {
      clearUserData();
      hasLoadedUserData.current = false;
      setIsSuperUserLoading(false);
      setIsSuperUser(false);
      return;
    }

    // Ha már betöltöttük, ne futtassuk újra
    if (hasLoadedUserData.current) {
      setIsSuperUserLoading(false);
      return;
    }

    hasLoadedUserData.current = true;
    setIsSuperUserLoading(true);

    // Háttérben frissítjük az adatokat (nem blokkolja a UI-t)
    getCurrentUserData()
      .then((data) => {
        console.log("🔍 getCurrentUserData result:", data);
        if (userEmail) {
          setUserData(data.isTenant ?? true, userEmail);
          if ("isSuperUser" in data) {
            console.log(
              "✅ Setting isSuperUser to:",
              data.isSuperUser ?? false
            );
            setIsSuperUser(data.isSuperUser ?? false);
          }
        }
      })
      .catch((error) => {
        console.error("❌ getCurrentUserData error:", error);
        if (userEmail) {
          setUserData(true, userEmail);
        }
      })
      .finally(() => {
        console.log("✅ isSuperUserLoading set to false");
        setIsSuperUserLoading(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.emailAddresses?.[0]?.emailAddress]);

  // Fetch subscription plan
  useEffect(() => {
    getUserSubscription().then((subscription) => {
      if (subscription) {
        const planMap: Record<string, string> = {
          [process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_PRO || ""]: "Pro",
          [process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_PRO_YEARLY || ""]: "Pro",
          [process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_PREMIUM || ""]: "Premium",
          [process.env.NEXT_PUBLIC_STRIPE_PRICE_ID_PREMIUM_YEARLY || ""]:
            "Premium",
        };
        setSubscriptionPlan(planMap[subscription.stripePriceId] || null);
      }
    });
  }, [user]);

  const handleGenerateInvite = async () => {
    setInviteLoading(true);
    setInviteCopied(false);

    const result = await generateInviteLink();

    if (result.success && result.inviteUrl) {
      // Vágólapra másolás - iOS kompatibilis verzió
      try {
        // Próbáljuk a modern API-t
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(result.inviteUrl);
        } else {
          // Fallback iOS-hez és régebbi böngészőkhöz
          const textArea = document.createElement("textarea");
          textArea.value = result.inviteUrl;
          textArea.style.position = "fixed";
          textArea.style.left = "-999999px";
          textArea.style.top = "-999999px";
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();

          try {
            document.execCommand("copy");
          } catch (err) {
            console.error("Fallback copy failed:", err);
          }

          document.body.removeChild(textArea);
        }

        setInviteCopied(true);

        // 3 másodperc után eltűnik a "Másolva" jelzés
        setTimeout(() => {
          setInviteCopied(false);
        }, 3000);
      } catch (err) {
        console.error("Copy to clipboard failed:", err);
        // iOS-en és ha a clipboard nem működik, megjelenítjük a linket egy dialógusban
        setInviteLinkDialog(result.inviteUrl);
      }
    }

    setInviteLoading(false);
  };

  console.log(isSuperUserLoading);

  return (
    <Sidebar className="bg-gradient-to-b from-gray-900 to-gray-800 text-gray-100 border-r border-gray-700">
      <SidebarHeader className="bg-gradient-to-b from-gray-900 to-gray-800 border-b border-gray-700">
        <div className="p-3 flex flex-col items-center">
          <Image
            src={"/logo.svg"}
            alt="logo"
            width={100}
            height={100}
            className="mb-2"
          />
        </div>
      </SidebarHeader>

      <SidebarContent className="bg-gradient-to-b from-gray-900 to-gray-800 flex flex-col">
        <SidebarGroup className="flex-1">
          <SidebarGroupContent className="bg-transparent">
            <SidebarMenu className="mt-2 space-y-2">
              {mainItems
                .filter((item) => {
                  // Hide tenant-only items for non-tenant users (workers)
                  if (!isTenant && item.tenantOnly) {
                    return false;
                  }
                  // Hide superUser-only items for non-superusers
                  if (!isSuperUser && item.superUserOnly) {
                    return false;
                  }
                  return true;
                })
                .map((item, index) => {
                  const isActive =
                    path === item.url || path.startsWith(item.url + "/");

                  return (
                    <Link
                      key={index}
                      href={item.url}
                      style={{
                        backgroundColor: isActive ? "#DE6B12" : "transparent",
                        color: isActive ? "white" : "#D1D5DB",
                        boxShadow: isActive
                          ? "0 10px 15px -3px rgba(222, 107, 18, 0.3)"
                          : "none",
                      }}
                      onMouseEnter={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.backgroundColor = "#374151";
                          e.currentTarget.style.color = "#DE6B12";
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.backgroundColor = "transparent";
                          e.currentTarget.style.color = "#D1D5DB";
                        }
                      }}
                      onTouchStart={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.backgroundColor = "#374151";
                          e.currentTarget.style.color = "#DE6B12";
                        }
                      }}
                      onTouchEnd={(e) => {
                        if (!isActive) {
                          e.currentTarget.style.backgroundColor = "transparent";
                          e.currentTarget.style.color = "#D1D5DB";
                        }
                      }}
                      className={`flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium transition-all cursor-pointer active:bg-[#374151] active:text-[#DE6B12]`}
                    >
                      <item.icon className="w-5 h-5 flex-shrink-0" />
                      <span className="truncate">{item.title}</span>
                    </Link>
                  );
                })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Secondary items pushed to bottom */}
        <div className="mt-auto border-t border-gray-700 pt-3 pb-3">
          <div className="flex flex-col gap-2 px-2">
            {secondaryItems.map((item, index) => {
              const isActive = path === item.url;
              const isBillingItem = item.url === "/billing";
              return (
                <Link
                  key={"secondary-" + index}
                  href={item.url}
                  style={{
                    backgroundColor: isActive
                      ? "#DE6B12"
                      : "rgba(55, 65, 81, 0.5)",
                    color: isActive ? "white" : "#D1D5DB",
                    borderColor: "#4B5563",
                    boxShadow: isActive
                      ? "0 10px 15px -3px rgba(222, 107, 18, 0.3)"
                      : "none",
                  }}
                  onMouseEnter={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "#4B5563";
                      e.currentTarget.style.color = "#DE6B12";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor =
                        "rgba(55, 65, 81, 0.5)";
                      e.currentTarget.style.color = "#D1D5DB";
                    }
                  }}
                  onTouchStart={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor = "#4B5563";
                      e.currentTarget.style.color = "#DE6B12";
                    }
                  }}
                  onTouchEnd={(e) => {
                    if (!isActive) {
                      e.currentTarget.style.backgroundColor =
                        "rgba(55, 65, 81, 0.5)";
                      e.currentTarget.style.color = "#D1D5DB";
                    }
                  }}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all border cursor-pointer active:bg-[#4B5563] active:text-[#DE6B12]`}
                >
                  <item.icon className="h-5 w-5 flex-shrink-0" />
                  <span className="truncate flex-1">{item.title}</span>
                  {isBillingItem && subscriptionPlan && (
                    <div className="flex items-center gap-1">
                      <Sparkles className="h-4 w-4 text-purple-400" />
                      <span className="text-xs font-semibold text-purple-400">
                        {subscriptionPlan}
                      </span>
                    </div>
                  )}
                </Link>
              );
            })}

            {/* Meghívás gomb - csak superUser-eknek */}
            {isSuperUser && (
              <button
                onClick={handleGenerateInvite}
                disabled={inviteLoading}
                style={{
                  backgroundColor: inviteCopied
                    ? "#10B981"
                    : "rgba(55, 65, 81, 0.5)",
                  color: inviteCopied ? "white" : "#D1D5DB",
                  borderColor: inviteCopied ? "#10B981" : "#4B5563",
                  boxShadow: inviteCopied
                    ? "0 10px 15px -3px rgba(16, 185, 129, 0.3)"
                    : "none",
                }}
                onMouseEnter={(e) => {
                  if (!inviteCopied && !inviteLoading) {
                    e.currentTarget.style.backgroundColor = "#4B5563";
                    e.currentTarget.style.color = "#DE6B12";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!inviteCopied && !inviteLoading) {
                    e.currentTarget.style.backgroundColor =
                      "rgba(55, 65, 81, 0.5)";
                    e.currentTarget.style.color = "#D1D5DB";
                  }
                }}
                onTouchStart={(e) => {
                  if (!inviteCopied && !inviteLoading) {
                    e.currentTarget.style.backgroundColor = "#4B5563";
                    e.currentTarget.style.color = "#DE6B12";
                  }
                }}
                onTouchEnd={(e) => {
                  if (!inviteCopied && !inviteLoading) {
                    e.currentTarget.style.backgroundColor =
                      "rgba(55, 65, 81, 0.5)";
                    e.currentTarget.style.color = "#D1D5DB";
                  }
                }}
                className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all border cursor-pointer active:bg-[#4B5563] active:text-[#DE6B12] ${
                  inviteLoading ? "opacity-50 cursor-not-allowed" : ""
                }`}
              >
                {inviteCopied ? (
                  <Check className="h-5 w-5 flex-shrink-0" />
                ) : (
                  <UserPlus className="h-5 w-5 flex-shrink-0" />
                )}
                <span className="truncate">
                  {inviteCopied ? "Másolva!" : "Meghívás"}
                </span>
              </button>
            )}
          </div>
        </div>
      </SidebarContent>

      <div className="flex flex-col items-center w-full border-t border-gray-700 pt-3 pb-3 bg-gradient-to-b from-gray-900 to-gray-800">
        <TenantSelectorSidebar />

        <UserButton afterSignOutUrl="/" />

        {showThemeSelector && (
          <div className="mt-3 w-full px-3">
            <div className="bg-gray-800 border border-gray-600 rounded-lg p-3 shadow-xl">
              <div className="flex justify-between items-center mb-2">
                <h2 className="text-xs font-semibold text-orange-400">
                  Háttér választása
                </h2>
                <button
                  onClick={() => setShowThemeSelector(false)}
                  className="text-gray-500 hover:text-orange-400 transition-colors"
                >
                  <X size={16} />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(["landing", "corporate", "common"] as const).map((theme) => (
                  <button
                    key={theme}
                    onClick={() => {
                      setTheme(theme);
                      setShowThemeSelector(false);
                    }}
                    style={{
                      backgroundColor:
                        currentTheme === theme ? "#DE6B12" : "#374151",
                      color: currentTheme === theme ? "white" : "#D1D5DB",
                      boxShadow:
                        currentTheme === theme
                          ? "0 10px 15px -3px rgba(222, 107, 18, 0.3)"
                          : "none",
                    }}
                    onMouseEnter={(e) => {
                      if (currentTheme !== theme) {
                        e.currentTarget.style.backgroundColor = "#4B5563";
                        e.currentTarget.style.color = "#DE6B12";
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (currentTheme !== theme) {
                        e.currentTarget.style.backgroundColor = "#374151";
                        e.currentTarget.style.color = "#D1D5DB";
                      }
                    }}
                    onTouchStart={(e) => {
                      if (currentTheme !== theme) {
                        e.currentTarget.style.backgroundColor = "#4B5563";
                        e.currentTarget.style.color = "#DE6B12";
                      }
                    }}
                    onTouchEnd={(e) => {
                      if (currentTheme !== theme) {
                        e.currentTarget.style.backgroundColor = "#374151";
                        e.currentTarget.style.color = "#D1D5DB";
                      }
                    }}
                    className={`p-2 rounded-md text-xs font-medium transition-all cursor-pointer active:bg-[#4B5563] active:text-[#DE6B12]`}
                  >
                    {theme.charAt(0).toUpperCase() + theme.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        <button
          onClick={() => setShowThemeSelector(!showThemeSelector)}
          style={{
            backgroundColor: "#374151",
            color: "#DE6B12",
            borderColor: "#4B5563",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.backgroundColor = "#4B5563";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.backgroundColor = "#374151";
          }}
          onTouchStart={(e) => {
            e.currentTarget.style.backgroundColor = "#4B5563";
          }}
          onTouchEnd={(e) => {
            e.currentTarget.style.backgroundColor = "#374151";
          }}
          className="w-11/12 mt-2 py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-2 transition-colors border cursor-pointer active:bg-[#4B5563]"
        >
          <Palette size={14} />
          <span>Háttér</span>
        </button>
      </div>

      <SidebarFooter className="bg-gradient-to-b from-gray-900 to-gray-800 border-t border-gray-700">
        <div className="w-full px-3 pb-2">
          <button
            onClick={async () => {
              if (signingOut) return;
              setSigningOut(true);

              // Timeout fallback - 3 másodperc után mindenképpen átirányít
              const timeoutId = setTimeout(() => {
                window.location.href = "/";
              }, 3000);

              try {
                await signOut();
                clearTimeout(timeoutId);
                window.location.href = "/";
              } catch (error) {
                console.log(error);
                clearTimeout(timeoutId);
                window.location.href = "/";
              }
            }}
            style={{
              borderColor: "#DE6B12",
              color: "#DE6B12",
              opacity: signingOut ? 0.5 : 1,
              cursor: signingOut ? "not-allowed" : "pointer",
              pointerEvents: signingOut ? "none" : "auto",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "#DE6B12";
              e.currentTarget.style.color = "white";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "#DE6B12";
            }}
            onTouchStart={(e) => {
              e.currentTarget.style.backgroundColor = "#DE6B12";
              e.currentTarget.style.color = "white";
            }}
            onTouchEnd={(e) => {
              e.currentTarget.style.backgroundColor = "transparent";
              e.currentTarget.style.color = "#DE6B12";
            }}
            className="w-full px-3 py-2 border rounded-lg text-xs font-medium transition-colors cursor-pointer active:bg-[#DE6B12] active:text-white"
          >
            Kijelentkezés
          </button>
        </div>
      </SidebarFooter>

      {/* Meghívó link dialógus iOS-hez (ahol a clipboard nem működik) */}
      {inviteLinkDialog && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => setInviteLinkDialog(null)}
        >
          <div
            className="bg-white rounded-xl p-6 mx-4 max-w-md w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-gray-900 mb-3">Meghívó link</h3>
            <p className="text-sm text-gray-600 mb-3">
              Jelöld ki és másold a linket:
            </p>
            <input
              type="text"
              readOnly
              value={inviteLinkDialog}
              className="w-full p-3 bg-gray-100 border border-gray-300 rounded-lg text-sm text-gray-800 select-all"
              onClick={(e) => (e.target as HTMLInputElement).select()}
              onFocus={(e) => e.target.select()}
            />
            <button
              onClick={() => setInviteLinkDialog(null)}
              className="w-full mt-4 py-3 bg-[#FF9900] text-white rounded-lg font-medium hover:bg-[#e68a00] transition-colors"
            >
              OK
            </button>
          </div>
        </div>
      )}
    </Sidebar>
  );
}
