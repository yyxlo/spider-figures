from collections import OrderedDict

from django.conf import settings
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.core.exceptions import PermissionDenied
from django.core.paginator import Paginator
from django.db import transaction
from django.db.models import Count, Prefetch, Q
from django.http import HttpResponse, JsonResponse
from django.shortcuts import get_object_or_404, redirect, render
from django.urls import reverse
from django.utils.http import url_has_allowed_host_and_scheme
from django.views.decorators.http import require_POST
from django.views.static import serve

from .forms import FigureBatchFormSet, FigureEditForm, ReferenceForm, SpeciesCreateForm, UploadForm
from .models import Family, Figure, Genus, Reference, Species, Structure
from .search import autocomplete, reference_search, search_names

FIGURE_RELATED = ["species__genus", "reference", "structure"]


def _figure_filters(request):
    """Structure / sex filters shared by genus, species and compare pages."""
    structure = request.GET.get("structure") or ""
    sex = request.GET.get("sex") or ""
    q = Q()
    if structure.isdigit():
        q &= Q(structure_id=int(structure))
    if sex in {"M", "F", "J"}:
        q &= Q(sex=sex)
    return q, {"structure": structure, "sex": sex}


def _filter_context(selected):
    return {
        "structures": Structure.objects.all(),
        "sex_choices": [c for c in Figure.SEX_CHOICES if c[0]],
        "selected": selected,
    }


def _safe_next(request, default):
    nxt = request.POST.get("next") or request.GET.get("next")
    if nxt and url_has_allowed_host_and_scheme(nxt, {request.get_host()}):
        return nxt
    return default


@login_required
def protected_media(request, path):
    return serve(request, path, document_root=settings.MEDIA_ROOT)


@login_required
def home(request):
    ctx = {
        "counts": {
            "families": Family.objects.count(),
            "genera": Genus.objects.count(),
            "species": Species.objects.count(),
            "figures": Figure.objects.count(),
            "references": Reference.objects.count(),
            "species_with_figures": Species.objects.filter(figures__isnull=False).distinct().count(),
        },
        "recent": Figure.objects.select_related(*FIGURE_RELATED).order_by("-created_at")[:12],
        "families": Family.objects.annotate(
            n_fig=Count("genera__species__figures")).filter(n_fig__gt=0).order_by("name"),
    }
    return render(request, "catalog/home.html", ctx)


@login_required
def search(request):
    q = request.GET.get("q", "").strip()
    found = search_names(q, limit=200)
    total = len(found["families"]) + len(found["genera"]) + len(found["species"])
    if total == 1 and not found.get("fuzzy"):
        only = (found["families"] or found["genera"] or found["species"])[0]
        return redirect(only.get_absolute_url())
    species_ids = [s.pk for s in found["species"]]
    fig_counts = dict(
        Species.objects.filter(pk__in=species_ids).annotate(n=Count("figures")).values_list("pk", "n")
    )
    for s in found["species"]:
        s.n_figures = fig_counts.get(s.pk, 0)
    return render(request, "catalog/search.html", {"q": q, "found": found, "total": total})


@login_required
def api_autocomplete(request):
    q = request.GET.get("q", "")
    kinds = request.GET.get("kinds", "family,genus,species").split(",")
    return JsonResponse({"results": autocomplete(q, kinds=kinds)})


@login_required
def api_references(request):
    q = request.GET.get("q", "")
    results = [
        {"id": r.pk, "label": str(r), "sub": f"{r.n} 張圖", "url": r.get_absolute_url()}
        for r in reference_search(q)
    ]
    return JsonResponse({"results": results})


@login_required
def family_detail(request, pk):
    family = get_object_or_404(Family, pk=pk)
    genera = family.genera.annotate(
        n_species=Count("species", filter=Q(species__valid_species__isnull=True), distinct=True),
        n_figures=Count("species__figures", distinct=True),
    )
    show_all = request.GET.get("all") == "1"
    if not show_all:
        genera = genera.filter(n_figures__gt=0)
    return render(request, "catalog/family_detail.html",
                  {"family": family, "genera": genera, "show_all": show_all})


def _group_by_accepted(figures):
    """Map accepted species -> list of figures (figures under synonyms join their valid name)."""
    groups = OrderedDict()
    for fig in figures:
        groups.setdefault(fig.species.valid_species_id or fig.species_id, []).append(fig)
    return groups


@login_required
def genus_detail(request, pk):
    genus = get_object_or_404(Genus.objects.select_related("family"), pk=pk)
    fq, selected = _figure_filters(request)
    figures = (
        Figure.objects.filter(fq)
        .filter(Q(species__genus=genus) | Q(species__valid_species__genus=genus))
        .select_related(*FIGURE_RELATED, "species__valid_species")
        .order_by("structure__order", "sex", "reference__year")
    )
    groups = _group_by_accepted(figures)
    accepted = genus.species.filter(valid_species__isnull=True).select_related("genus")
    show_empty = request.GET.get("empty") == "1"
    rows = []
    for sp in accepted:
        figs = groups.pop(sp.pk, [])
        if figs or show_empty:
            rows.append({"species": sp, "figures": figs})
    # synonyms in this genus whose valid name sits in another genus
    for valid_id, figs in groups.items():
        rows.append({"species": Species.objects.select_related("genus").get(pk=valid_id), "figures": figs})
    ctx = {"genus": genus, "rows": rows, "show_empty": show_empty,
           "n_species": accepted.count(), **_filter_context(selected)}
    return render(request, "catalog/genus_detail.html", ctx)


@login_required
def species_detail(request, pk):
    species = get_object_or_404(Species.objects.select_related("genus__family", "valid_species__genus"), pk=pk)
    accepted = species.accepted
    fq, selected = _figure_filters(request)
    figures = accepted.all_figures().filter(fq).select_related(*FIGURE_RELATED)
    sections = OrderedDict()
    for fig in figures:
        sections.setdefault(fig.structure, []).append(fig)
    synonyms = accepted.synonyms.select_related("genus")
    ctx = {"species": species, "accepted": accepted, "sections": sections, "synonyms": synonyms,
           "n_figures": figures.count(), **_filter_context(selected)}
    return render(request, "catalog/species_detail.html", ctx)


@login_required
def compare(request):
    ids = []
    for raw in request.GET.getlist("species"):
        for part in raw.split(","):
            if part.isdigit() and int(part) not in ids:
                ids.append(int(part))
    fq, selected = _figure_filters(request)
    columns = []
    species_map = Species.objects.select_related("genus", "valid_species__genus").in_bulk(ids)
    for sid in ids:
        sp = species_map.get(sid)
        if sp is None:
            continue
        figs = sp.accepted.all_figures().filter(fq).select_related(*FIGURE_RELATED)
        others = [i for i in ids if i != sid]
        columns.append({"species": sp, "figures": figs, "others": ",".join(map(str, others))})
    ctx = {"columns": columns, "ids": ",".join(map(str, ids)), **_filter_context(selected)}
    return render(request, "catalog/compare.html", ctx)


@login_required
def upload(request):
    initial = {}
    if request.GET.get("species"):
        initial["species"] = request.GET["species"]
    if request.GET.get("reference"):
        initial["reference"] = request.GET["reference"]
    if request.method == "POST":
        form = UploadForm(request.POST, request.FILES)
        if form.is_valid():
            d = form.cleaned_data
            with transaction.atomic():
                reference = form.get_reference()
                created = []
                for img in d["images"]:
                    fig = Figure(
                        species=d["species"], reference=reference, image=img,
                        structure=d["structure"], sex=d["sex"], view=d["view"], page=d["page"],
                        uploaded_by=request.user,
                    )
                    fig.save()
                    created.append(fig.pk)
            messages.success(request, f"已上傳 {len(created)} 張圖片，請補上各圖的圖號與構造。")
            return redirect(reverse("figure_batch_edit") + "?ids=" + ",".join(map(str, created)))
    else:
        form = UploadForm(initial=initial)
    return render(request, "catalog/upload.html", {"form": form, "ref_form": form.ref_form})


@login_required
def figure_batch_edit(request):
    ids = [int(i) for i in request.GET.get("ids", "").split(",") if i.isdigit()]
    qs = Figure.objects.filter(pk__in=ids).select_related(*FIGURE_RELATED).order_by("pk")
    if request.method == "POST":
        formset = FigureBatchFormSet(request.POST, queryset=qs)
        if formset.is_valid():
            formset.save()
            messages.success(request, "已儲存。")
            first = qs.first()
            return redirect(first.species.get_absolute_url() if first else "home")
    else:
        formset = FigureBatchFormSet(queryset=qs)
    return render(request, "catalog/figure_batch_edit.html", {"formset": formset})


def _can_modify(user, figure):
    return user.is_staff or figure.uploaded_by_id == user.pk


@login_required
def figure_detail(request, pk):
    fig = get_object_or_404(Figure.objects.select_related(*FIGURE_RELATED, "uploaded_by"), pk=pk)
    return render(request, "catalog/figure_detail.html",
                  {"fig": fig, "can_modify": _can_modify(request.user, fig)})


@login_required
def figure_edit(request, pk):
    fig = get_object_or_404(Figure, pk=pk)
    if not _can_modify(request.user, fig):
        raise PermissionDenied
    form = FigureEditForm(request.POST or None, instance=fig)
    if request.method == "POST" and form.is_valid():
        form.save()
        messages.success(request, "已更新。")
        return redirect(fig)
    return render(request, "catalog/form_page.html",
                  {"form": form, "title": f"編輯圖片：{fig}", "preview": fig})


@login_required
@require_POST
def figure_delete(request, pk):
    fig = get_object_or_404(Figure.objects.select_related("species"), pk=pk)
    if not _can_modify(request.user, fig):
        raise PermissionDenied
    species = fig.species
    fig.delete()
    messages.success(request, "已刪除圖片。")
    return redirect(species)


@login_required
def reference_list(request):
    q = request.GET.get("q", "").strip()
    qs = reference_search(q, limit=None) if q else Reference.objects.annotate(n=Count("figures")).order_by(
        "authors", "year")
    page = Paginator(qs, 50).get_page(request.GET.get("page"))
    return render(request, "catalog/reference_list.html", {"page": page, "q": q})


@login_required
def reference_detail(request, pk):
    ref = get_object_or_404(Reference, pk=pk)
    figures = ref.figures.select_related(*FIGURE_RELATED).order_by(
        "species__genus__name", "species__epithet", "structure__order")
    by_species = OrderedDict()
    for fig in figures:
        by_species.setdefault(fig.species, []).append(fig)
    return render(request, "catalog/reference_detail.html", {"ref": ref, "by_species": by_species})


@login_required
def reference_bibtex(request, pk):
    ref = get_object_or_404(Reference, pk=pk)
    return HttpResponse(ref.bibtex(), content_type="text/plain; charset=utf-8")


@login_required
def reference_edit(request, pk=None):
    ref = get_object_or_404(Reference, pk=pk) if pk else None
    form = ReferenceForm(request.POST or None, instance=ref)
    if request.method == "POST" and form.is_valid():
        ref = form.save()
        messages.success(request, "文獻已儲存。")
        return redirect(_safe_next(request, ref.get_absolute_url()))
    title = "編輯文獻" if pk else "新增文獻"
    return render(request, "catalog/form_page.html", {"form": form, "title": title})


@login_required
def species_create(request):
    form = SpeciesCreateForm(request.POST or None, initial={"genus_name": request.GET.get("genus", "")})
    if request.method == "POST" and form.is_valid():
        sp = form.save()
        messages.success(request, f"已新增物種 {sp.full_name}")
        default = reverse("upload") + f"?species={sp.pk}"
        return redirect(_safe_next(request, default))
    return render(request, "catalog/form_page.html", {
        "form": form, "title": "新增物種名",
        "help": "名錄中找不到時才需要新增（例如文獻使用的舊名、同物異名或尚未匯入的新種）。",
    })


@login_required
def taxa_index(request):
    families = Family.objects.annotate(
        n_genera=Count("genera", distinct=True),
        n_figures=Count("genera__species__figures", distinct=True),
    )
    return render(request, "catalog/taxa_index.html", {"families": families})
