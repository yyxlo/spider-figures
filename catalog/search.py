"""Name search across families, genera and species.

Uses prefix / substring matching everywhere, and on PostgreSQL falls back
to trigram similarity (pg_trgm) so that misspelled names still match.
"""
from django.db import connection
from django.db.models import Count, Q, Value
from django.db.models.functions import Concat

from .models import Family, Genus, Reference, Species


def _trigram_available():
    return connection.vendor == "postgresql"


def search_names(q, limit=50):
    q = " ".join(q.split())
    result = {"families": [], "genera": [], "species": []}
    if not q:
        return result

    parts = q.split(" ")
    species_qs = Species.objects.select_related("genus__family", "valid_species__genus")

    if len(parts) >= 2:
        # "Genus epithet [subspecies]" – the genus may be abbreviated or partial
        sq = Q(genus__name__istartswith=parts[0].rstrip(".")) & Q(epithet__istartswith=parts[1])
        if len(parts) >= 3:
            sq &= Q(subspecies__istartswith=parts[2])
        sq |= Q(common_name__icontains=q)
        result["species"] = list(species_qs.filter(sq)[:limit])
    else:
        result["families"] = list(
            Family.objects.filter(Q(name__istartswith=q) | Q(common_name__icontains=q))[:limit]
        )
        result["genera"] = list(
            Genus.objects.select_related("family")
            .filter(Q(name__istartswith=q) | Q(common_name__icontains=q))[:limit]
        )
        result["species"] = list(
            species_qs.filter(Q(epithet__istartswith=q) | Q(common_name__icontains=q))[:limit]
        )

    if not any(result.values()) and _trigram_available():
        result = _trigram_search(q, limit)
        result["fuzzy"] = True
    return result


def _trigram_search(q, limit):
    from django.contrib.postgres.search import TrigramSimilarity

    threshold = 0.3
    families = (
        Family.objects.annotate(sim=TrigramSimilarity("name", q))
        .filter(sim__gte=threshold).order_by("-sim")[:limit]
    )
    genera = (
        Genus.objects.select_related("family").annotate(sim=TrigramSimilarity("name", q))
        .filter(sim__gte=threshold).order_by("-sim")[:limit]
    )
    species = (
        Species.objects.select_related("genus__family", "valid_species__genus")
        .annotate(full=Concat("genus__name", Value(" "), "epithet"))
        .annotate(sim=TrigramSimilarity("full", q))
        .filter(sim__gte=threshold).order_by("-sim")[:limit]
    )
    return {"families": list(families), "genera": list(genera), "species": list(species)}


def autocomplete(q, kinds=("family", "genus", "species"), limit=15):
    """Small result list for the search box / form widgets."""
    found = search_names(q, limit=limit)
    items = []
    if "family" in kinds:
        items += [
            {"type": "family", "id": f.pk, "label": f.name, "sub": "科 " + f.common_name,
             "url": f.get_absolute_url()}
            for f in found["families"]
        ]
    if "genus" in kinds:
        items += [
            {"type": "genus", "id": g.pk, "label": g.name,
             "sub": f"屬 · {g.family.name} {g.common_name}".strip(), "url": g.get_absolute_url()}
            for g in found["genera"]
        ]
    if "species" in kinds:
        for s in found["species"]:
            sub = s.common_name
            if s.is_synonym:
                sub = f"→ 有效名 {s.valid_species.name}"
            items.append({"type": "species", "id": s.pk, "label": s.full_name, "sub": sub,
                          "url": s.get_absolute_url()})
    return items[:limit * 2]


def reference_search(q, limit=20):
    qs = Reference.objects.annotate(n=Count("figures"))
    for term in q.split():
        qs = qs.filter(Q(authors__icontains=term) | Q(year__istartswith=term) | Q(title__icontains=term)
                       | Q(journal__icontains=term) | Q(doi__icontains=term))
    return qs.order_by("authors", "year")[:limit]
