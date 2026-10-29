"""Export the database and uploaded figures as a ready-to-use NAS library folder.

The output is a copy of nas-site/ (the static version that is opened straight from a shared
folder) filled with this database's checklist, references, structures and figures.

    python manage.py export_static /app/export
"""
import json
import shutil
import time
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from catalog.models import Family, Figure, Genus, Reference, Species, Structure

# Must match DEFAULT_STRUCTURES in nas-site/app/app.js
DEFAULT_STRUCTURE_IDS = {
    "整體外觀": "s-habitus", "頭胸部與眼區": "s-prosoma", "螯肢": "s-chelicerae", "步足": "s-legs",
    "腹部": "s-opisthosoma", "紡器": "s-spinnerets", "雄觸肢": "s-palp", "觸肢器細部": "s-palp-detail",
    "雌外生殖器": "s-epigyne", "雌內生殖器": "s-vulva", "其他": "s-other",
}
REFERENCE_FIELDS = ["authors", "year", "title", "journal", "volume", "issue", "pages", "publisher", "doi", "url", "notes"]


def ms(dt):
    return int(dt.timestamp() * 1000) if dt else int(time.time() * 1000)


def safe(s):
    return "".join(c if c.isalnum() or c in "_-" else "_" for c in s)[:40] or "x"


class Command(BaseCommand):
    help = "匯出成可直接放在 NAS 共用資料夾使用的圖片庫（靜態網頁版）"

    def add_arguments(self, parser):
        parser.add_argument("dest", help="輸出資料夾（必須不存在或是空的）")

    def handle(self, dest, **opts):
        template = Path(settings.BASE_DIR) / "nas-site"
        out = Path(dest)
        if not (template / "index.html").exists():
            raise CommandError(f"找不到靜態網頁版範本：{template}")
        if out.exists() and any(out.iterdir()):
            raise CommandError(f"{out} 已存在且不是空的，請指定新的資料夾")
        shutil.copytree(template, out, dirs_exist_ok=True,
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))

        self.write_taxa(out)
        records = []
        records += self.export_structures(out)
        ref_ids = {}
        for ref in Reference.objects.all():
            ref_ids[ref.pk] = f"ref-{ref.pk}"
            data = {f: getattr(ref, f) for f in REFERENCE_FIELDS}
            records.append(self.write_record(out, "reference", ref_ids[ref.pk], data))

        n_fig = 0
        for fig in Figure.objects.select_related("species__genus", "reference", "structure", "uploaded_by"):
            if not fig.image:
                continue
            if not fig.medium or not fig.thumbnail:
                fig.save(regenerate=True)
            fid = f"fig-{fig.pk}"
            base = f"{safe(fig.species.genus.name)}/{safe(fig.species.epithet)}_{fid}"
            ext = Path(fig.image.name).suffix.lower() or ".jpg"
            files = {
                "original": f"images/original/{base}{ext}",
                "medium": f"images/medium/{base}.jpg",
                "thumb": f"images/thumb/{base}.jpg",
            }
            for key, field in (("original", fig.image), ("medium", fig.medium), ("thumb", fig.thumbnail)):
                target = out / files[key]
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(field.path, target)
            data = {
                "species": fig.species.name,
                "reference": ref_ids[fig.reference_id],
                "figure_number": fig.figure_number,
                "page": fig.page,
                "structure": self.structure_ids.get(fig.structure_id, ""),
                "sex": fig.sex,
                "view": fig.view,
                "notes": fig.notes,
                "files": files,
                "created": ms(fig.created_at),
                "updated": ms(fig.updated_at),
                "by": fig.uploaded_by.username if fig.uploaded_by else "",
            }
            records.append(self.write_record(out, "figure", fid, data))
            n_fig += 1

        index = {"generated": int(time.time() * 1000), "records": records}
        (out / "data" / "index.js").write_text(
            "window.SPIDER_INDEX = " + json.dumps(index, ensure_ascii=False) + ";\n", encoding="utf-8")
        self.stdout.write(self.style.SUCCESS(
            f"已匯出到 {out}：{Species.objects.count()} 個物種名、{len(ref_ids)} 篇文獻、{n_fig} 張圖"))

    def write_taxa(self, out):
        taxa = {
            "families": {f.name: {k: v for k, v in (("author", f.author), ("zh", f.common_name)) if v}
                         for f in Family.objects.all()},
            "genera": {g.name: {k: v for k, v in (("family", g.family.name), ("author", g.author), ("zh", g.common_name)) if v}
                       for g in Genus.objects.select_related("family")},
            "species": [
                [s.genus.name, s.epithet, s.subspecies, s.author, s.wsc_lsid, s.common_name,
                 s.valid_species.name if s.valid_species_id else ""]
                for s in Species.objects.select_related("genus", "valid_species__genus")
            ],
        }
        (out / "data" / "taxa.js").write_text(
            "window.SPIDER_TAXA = " + json.dumps(taxa, ensure_ascii=False) + ";\n", encoding="utf-8")

    def export_structures(self, out):
        self.structure_ids, records = {}, []
        for st in Structure.objects.all():
            sid = DEFAULT_STRUCTURE_IDS.get(st.name)
            if sid is None:
                sid = f"s-dj{st.pk}"
                records.append(self.write_record(out, "structure", sid,
                                                 {"name": st.name, "name_en": st.name_en, "order": st.order}))
            self.structure_ids[st.pk] = sid
        return records

    @staticmethod
    def write_record(out, kind, rid, data):
        path = out / "data" / "records" / kind / f"{rid}.json"
        path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
        return {**data, "type": kind, "id": rid, "_mtime": int(path.stat().st_mtime * 1000)}
