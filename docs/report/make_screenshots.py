"""Captures the running dashboard for the project report.

Drives a real Chromium through Playwright rather than a headless screenshot flag, because
almost every view worth showing is behind a login: the credential lives in sessionStorage,
so the browser has to be scripted to sign in, wait for data, and only then capture. A bare
`--screenshot` can photograph the sign-in page and nothing else.

Credentials are read from `hub/.env`, so this cannot drift from the running system, and no
secret is written into this file.

    python docs/report/make_screenshots.py

Requires the stack to be up:
    docker compose -f docker-compose.yml -f docker-compose.caddy.yml up -d
"""

import os
import re
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
OUT = os.path.join(HERE, "assets")
BASE = os.environ.get("DASHBOARD_URL", "http://localhost:8080")

# Wide enough that the dashboard uses its full multi-column layout — a narrow capture
# collapses the grid and misrepresents the design.
VIEWPORT = {"width": 1600, "height": 1000}


def env(name):
    with open(os.path.join(ROOT, "hub", ".env"), encoding="utf-8") as handle:
        match = re.search(r"^%s=(.*)$" % name, handle.read(), re.M)
    return match.group(1).strip() if match else None


def signed_in_page(browser, credential, label):
    """A page that is already authenticated when the application first boots.

    THE CREDENTIAL MUST EXIST BEFORE ANY APPLICATION CODE RUNS, which is why this uses an
    init script and a fresh context rather than writing to sessionStorage on a live page.

    Seeding a running page does not work, and the reason is a feature rather than a bug:
    sitting on the sign-in screen the dashboard asks `/auth/me` with an empty credential,
    receives a 401, and calls signOut() — which clears exactly the key just written. The
    app is defending itself against a stale credential and cannot tell the difference.

    A separate context per role also keeps the roles genuinely isolated, so the viewer
    screenshots cannot accidentally inherit an admin session.
    """
    context = browser.new_context(viewport=VIEWPORT, device_scale_factor=2)
    context.add_init_script(
        """
        window.sessionStorage.setItem('cpe310.operatorKey', '%s');
        window.localStorage.setItem('cpe310.operatorLabel', '%s');
        """
        % (credential, label)
    )
    page = context.new_page()
    page.goto(BASE, wait_until="domcontentloaded")
    page.wait_for_timeout(3000)
    return context, page


def shot(page, name, note):
    path = os.path.join(OUT, name)
    page.wait_for_timeout(800)
    page.screenshot(path=path)
    print("  %-38s %3d kB  %s" % (name, os.path.getsize(path) // 1024, note))


def element_shot(page, selector, name, note, has_text=None):
    """Captures one component. Reports rather than raises if it is not on screen."""
    try:
        target = (
            page.locator(selector, has_text=has_text).first
            if has_text
            else page.locator(selector).first
        )
        target.wait_for(state="visible", timeout=8000)
        target.screenshot(path=os.path.join(OUT, name))
        print("  %-38s        %s" % (name, note))
        return True
    except Exception as error:
        print("  %-38s SKIPPED (%s)" % (name, str(error).split("\n")[0][:60]))
        return False


def goto(page, route, settle=2600):
    # domcontentloaded, never networkidle: the dashboard holds a WebSocket open for the
    # life of the page, so the network is never idle and that wait always times out.
    page.goto(BASE + route, wait_until="domcontentloaded")
    page.wait_for_timeout(settle)


def main():
    os.makedirs(OUT, exist_ok=True)
    operator, admin, viewer = env("OPERATOR_KEY"), env("ADMIN_KEY"), env("VIEWER_KEY")
    if not operator:
        sys.exit("Could not read OPERATOR_KEY from hub/.env")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        print("Capturing %s" % BASE)

        # --- signed out ------------------------------------------------------
        plain = browser.new_context(viewport=VIEWPORT, device_scale_factor=2)
        page = plain.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_timeout(1500)
        shot(page, "shot01_signin.png", "sign-in, role-based credential")
        plain.close()

        # --- operator --------------------------------------------------------
        context, page = signed_in_page(browser, operator, "A. Rodriguez")
        shot(page, "shot02_overview.png", "operator overview")
        element_shot(page, ".command", "shot03_mode_control.png", "arm state control")
        element_shot(page, ".card", "shot04_alerts.png", "alert clustering", has_text="Alerts")
        element_shot(page, ".stat-row", "shot05_stats.png", "at-a-glance counters")
        element_shot(page, ".card", "shot06_agents.png", "agent fleet", has_text="Agents")
        element_shot(page, ".card", "shot07_events.png", "event stream", has_text="Event stream")

        goto(page, "/cameras")
        shot(page, "shot08_cameras.png", "camera wall, live MJPEG")
        element_shot(page, ".camera", "shot09_camera_tile.png", "single camera tile")

        goto(page, "/reports")
        shot(page, "shot10_reports.png", "reports over a 30 day window")
        element_shot(page, ".chart", "shot11_activity_chart.png", "daily activity chart")

        goto(page, "/settings")
        shot(page, "shot12_settings_operator.png", "settings as operator")
        element_shot(page, ".schedule-form, .panel-head", "shot13_schedules.png",
                     "scheduled arming")

        # A refused disarm, if a critical alert is currently open — the ABAC rule in action.
        goto(page, "/")
        try:
            page.get_by_role("button", name=re.compile(r"^\s*disarmed?\s*$", re.I)).first.click()
            page.wait_for_timeout(2000)
            element_shot(page, ".command", "shot14_disarm_refused.png", "policy refusal")
        except Exception as error:
            print("  %-38s SKIPPED (%s)" % ("shot14_disarm_refused.png",
                                            str(error).split("\n")[0][:60]))
        context.close()

        # --- admin -----------------------------------------------------------
        if admin:
            context, page = signed_in_page(browser, admin, "G. Hopper")
            goto(page, "/settings")
            shot(page, "shot15_settings_admin.png", "settings as admin, audit visible")
            element_shot(page, ".audit-list", "shot16_audit.png", "audit trail")
            goto(page, "/cameras")
            shot(page, "shot17_cameras_admin.png", "camera page with provisioning")
            context.close()

        # --- viewer ----------------------------------------------------------
        if viewer:
            context, page = signed_in_page(browser, viewer, "Read only")
            shot(page, "shot18_viewer_overview.png", "viewer: no arm controls")
            goto(page, "/settings")
            shot(page, "shot19_viewer_settings.png", "viewer: audit withheld")
            context.close()

        browser.close()
    print("done")


if __name__ == "__main__":
    main()
