export function preservesTeachingPracticeMechanism(message: string): boolean {
  const namesRecipientSubject =
    /\b(?:teach(?:ing|es|ers?)?|concepts?|curricul(?:um|a)|training|framework|method(?:s|ology)?|message)\b/i.test(
      message,
    );
  const preservesUnderstanding =
    /\b(?:understand(?:ing)?|comprehend(?:ing|sion)?|learn(?:ing)?|engag(?:e|es|ed|ing|ement))\b/i.test(
      message,
    );
  const preservesApplication =
    /\b(?:practic(?:e|es|ing|al)|apply|applies|applying|application|reinforc(?:e|es|ing|ement))\b/i.test(
      message,
    );
  return namesRecipientSubject && preservesUnderstanding && preservesApplication;
}

export function preservesDemoReviewInvitation(message: string): boolean {
  const namesDemonstration =
    /\b(?:demo(?:nstration)?|demonstrat(?:e|es|ed|ing)|walkthrough|preview)\b/i.test(
      message,
    );
  const invitesReview =
    /\b(?:show|share|offer|invite|open|review|see|walk through|take (?:a )?look|happy|love)\b/i.test(
      message,
    );
  return namesDemonstration && invitesReview;
}

export function preservesContingentPromotionCommissionPartnership(message: string): boolean {
  const promotion =
    /\b(?:advertis(?:e|es|ed|ing|ement)|promot(?:e|es|ed|ing|ion)|market(?:s|ed|ing)?|feature(?:s|d|ing)?)\b/i;
  const commission =
    /\b(?:commission|revenue shar(?:e|ing)|shar(?:e|ing) revenue|referral (?:fee|payment|compensation))\b/i;
  const referralOutcome =
    /\b(?:subscribers?|referrals?|referred|refer|customers?|clients?)\b/i;
  const contingency =
    /\bif\s+(?:(?:it|this|that|the (?:demo|platform|approach|idea|proposal))(?:(?:['’]s|\s+is)\s+(?:a\s+fit|useful|valuable)|\s+(?:align(?:s|ed)?(?:\s+with\b[^,;.!?]*)?|fit(?:s|ted)?\b|makes?\s+sense\b))|you\s+like\s+(?:it|what\s+you\s+(?:see|saw)))\b/i;
  const unconditionalOverride = /\b(?:regardless|unconditionally|either way|in any case|always)\b/i;

  return (message.match(/[^.!?]+[.!?]?/g) ?? []).some((sentence) => {
    const condition = sentence.match(contingency);
    const promotionOffer = sentence.match(promotion);
    if (
      !condition ||
      condition.index === undefined ||
      !promotionOffer ||
      promotionOffer.index === undefined ||
      promotionOffer.index < condition.index ||
      promotionOffer.index - condition.index > 180
    ) {
      return false;
    }
    const linkedProposition = sentence.slice(condition.index);
    return (
      !unconditionalOverride.test(linkedProposition) &&
      commission.test(linkedProposition) &&
      referralOutcome.test(linkedProposition)
    );
  });
}

export function preservesMultiOfficeCoordinationContext(message: string): boolean {
  const namesOperationalMovement =
    /\b(?:handoffs?|coordinat(?:e|es|ing|ion)|transfers?|transitions?|workflows?)\b/i.test(
      message,
    );
  const namesLocations = /\b(?:offices?|locations?|sites?|branches?)\b/i.test(message);
  const connectsLocations =
    /\b(?:between|across|both|two|second|multiple|new)\b/i.test(message);
  return namesOperationalMovement && namesLocations && connectsLocations;
}
