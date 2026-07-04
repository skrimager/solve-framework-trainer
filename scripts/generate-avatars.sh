#!/usr/bin/env bash
#
# Regenerates the persona portrait avatars for the home-improvement verticals
# (kitchen_remodel, bathroom_remodel, pool_installation, landscaping).
#
# The images committed for these 16 slugs are lightweight initial-based
# PLACEHOLDERS: the sandbox that authored the scenarios could not reach the
# image-generation backend (the `asi-generate-image` CLI requires the harness
# to inject `api_credentials=["llm-api:image"]` on the bash call, which was
# unavailable there). Run this from an environment where that credential is
# available to replace the placeholders with real portraits.
#
# Each asi-generate-image bash call MUST be made with the tool field
#   api_credentials=["llm-api:image"]
# The CLI writes ${filename}.png under /home/user/workspace; we then convert to
# the .jpg the app serves from client/public/avatars/.
#
# Usage:  bash scripts/generate-avatars.sh
set -euo pipefail

OUT_DIR="client/public/avatars"
WORKSPACE="/home/user/workspace"
STYLE="Warm neutral taupe and beige seamless studio background, soft diffused natural lighting, shallow depth of field. Head-and-shoulders framing, casual everyday clothing, looking toward the camera. Photorealistic, natural skin texture, authentic and candid like a real everyday person, not a glamorous stock model. No text, no watermark."

gen () {
  local slug="$1"; local desc="$2"
  asi-generate-image "{\"prompt\": \"Professional headshot-style portrait photograph of ${desc}. ${STYLE}\", \"filename\": \"${slug}\", \"aspect_ratio\": \"3:4\", \"model\": \"gpt_image_2\"}"
  convert "${WORKSPACE}/${slug}.png" -quality 88 "${OUT_DIR}/${slug}.jpg"
  echo "wrote ${OUT_DIR}/${slug}.jpg"
}

# --- Kitchen remodel ---
gen kitchen-remodel-outdated-layout-frustration "a friendly, approachable 42-year-old woman with a warm, engaged expression"
gen kitchen-remodel-overwhelmed-first-timer "a 35-year-old man with a slightly uncertain, mildly overwhelmed but earnest expression"
gen kitchen-remodel-couple-conflicting-budgets "an enthusiastic, well-put-together 46-year-old woman with a bright, hopeful expression"
gen kitchen-remodel-burned-by-change-orders "a guarded, skeptical 54-year-old man with a wary, arms-length expression"

# --- Bathroom remodel ---
gen bathroom-remodel-aging-in-place-unspoken "a warm, cheerful 68-year-old woman with an upbeat, dignified expression"
gen bathroom-remodel-quick-refresh-home-sale "a brisk, pragmatic 48-year-old man with a businesslike, matter-of-fact expression"
gen bathroom-remodel-landlord-rental-durability "a no-nonsense 51-year-old man with a businesslike, slightly impatient expression"
gen bathroom-remodel-botched-prior-job-distrust "a guarded, wary 45-year-old woman with a cautious, distrustful expression"

# --- Pool installation ---
gen pool-installation-family-kids-maintenance-blind "a cheerful 38-year-old woman with a bright, excited expression"
gen pool-installation-retiree-therapy-unspoken "a reserved, private 71-year-old man with a calm, measured expression"
gen pool-installation-hoa-permit-frustration "a slightly impatient 49-year-old woman with a frustrated but composed expression"
gen pool-installation-lowest-bid-steamroller "a confident, no-nonsense 50-year-old man with an assertive expression"

# --- Landscaping ---
gen landscaping-blank-yard-new-homeowner "a friendly, easygoing 34-year-old man with an open, slightly unsure expression"
gen landscaping-mow-trim-hidden-drainage "a casual, matter-of-fact 40-year-old woman with a relaxed expression"
gen landscaping-hoa-compliance-pressure "a 55-year-old man with a slightly irritated, embarrassed expression"
gen landscaping-failing-diy-defensive "a proud, slightly defensive 47-year-old woman with a guarded expression"

echo "All 16 avatars regenerated."
